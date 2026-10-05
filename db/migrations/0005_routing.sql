-- Up Migration
-- =====================================================================================================
-- 0005_routing — Stage 4: automatic routing.
--
--   routing_settings                    the on/off switch (per vertical), what the router may touch, and the "something changed" marker
--   routing_rules                       ordered, editable filters / limiters / rankers (new kinds need code; parameters, order and on/off do not)
--   routing_runs                        append-only: every routing attempt, with the rules in force and a verdict for every candidate
--   clients.priority/weight/caps/tz     what a business asked for
--   client_working_hours, client_pauses when a business wants leads
--   lead_assignments.routing_run_id     links an automatic assignment to the run that explains it
--
-- Cut from docs/design/target-schema.sql. Deliberately NOT here (see docs/00 D29-D33):
--   * `clients.max_open_leads`: "unanswered leads" cannot be measured until clients can accept or reject a lead (stage 6); until
--     then every sent lead stays "open" for ever and the limit would starve the client permanently.
--   * an exclusion constraint on overlapping pauses (needs the btree_gist extension, an install privilege a managed database may
--     not grant, for a rule that does not matter: a client is paused when ANY pause covers now).
--   * a `routing` lease and sweeper: a lead is claimed, decided and assigned in ONE transaction, so a crashed worker leaves
--     the lead exactly as it was (status `new`) and nothing needs recovering.
-- Roll-forward only.
-- =====================================================================================================

CREATE TYPE routing_outcome   AS ENUM ('assigned', 'no_candidates', 'error', 'skipped');
CREATE TYPE routing_rule_kind AS ENUM ('filter', 'limiter', 'ranker');

CREATE FUNCTION is_valid_timezone(tz text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = tz) $$;

-- ---------------------------------------------------------------------------------------------------
-- What a business asked for. Lower priority number wins; weight biases fairness (0 = "never route to me automatically").
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE clients
  ADD COLUMN timezone          text     NOT NULL DEFAULT 'Europe/London',
  ADD COLUMN priority          smallint NOT NULL DEFAULT 100,
  ADD COLUMN weight            smallint NOT NULL DEFAULT 1,
  ADD COLUMN daily_lead_cap    smallint,
  ADD COLUMN monthly_lead_cap  integer;
ALTER TABLE clients
  ADD CONSTRAINT clients_timezone_chk         CHECK (is_valid_timezone(timezone)),
  ADD CONSTRAINT clients_priority_chk         CHECK (priority BETWEEN 0 AND 1000),
  ADD CONSTRAINT clients_weight_chk           CHECK (weight BETWEEN 0 AND 100),
  ADD CONSTRAINT clients_daily_lead_cap_chk   CHECK (daily_lead_cap > 0),
  ADD CONSTRAINT clients_monthly_lead_cap_chk CHECK (monthly_lead_cap > 0);

-- No rows = no restriction (open any time). Weekday 0 = Sunday, in the client's timezone.
CREATE TABLE client_working_hours (
  client_id uuid     NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  weekday   smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens     time     NOT NULL,
  closes    time     NOT NULL,
  PRIMARY KEY (client_id, weekday, opens),
  CHECK (closes > opens)
);

-- A business is paused when ANY pause covers the moment (a holiday, a full diary).
CREATE TABLE client_pauses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid        NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text        NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 50),
  created_by uuid REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX client_pauses_client_idx ON client_pauses (client_id, ends_at);

-- ---------------------------------------------------------------------------------------------------
-- Routing configuration
-- ---------------------------------------------------------------------------------------------------
-- The switch. OFF by default: routing never starts by itself, and only leads that arrive WHILE it is on are ever routed (a backlog
-- of older leads is never sent to a business by surprise). `poked_at` is bumped whenever something the router's answer depends on
-- changes (a client, its coverage, a price, a rule), so leads that found nobody are looked at again promptly instead of waiting
-- for the slow retry.
CREATE TABLE routing_settings (
  vertical_id        integer PRIMARY KEY REFERENCES verticals (id),
  enabled            boolean     NOT NULL DEFAULT false,
  enabled_at         timestamptz,
  max_lead_age_hours smallint    NOT NULL DEFAULT 24 CHECK (max_lead_age_hours BETWEEN 1 AND 168),
  poked_at           timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid REFERENCES operators (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR enabled_at IS NOT NULL)
);
CREATE TRIGGER routing_settings_set_updated_at BEFORE UPDATE ON routing_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Each rule type exists once per vertical. Filters and limiters all have to pass (their order does not change the outcome);
-- rankers are applied in `position` order as successive tie-breakers.
CREATE TABLE routing_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_id integer           NOT NULL REFERENCES verticals (id),
  type        text              NOT NULL,
  kind        routing_rule_kind NOT NULL,
  position    smallint          NOT NULL,
  config      jsonb             NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  active      boolean           NOT NULL DEFAULT true,
  version     integer           NOT NULL DEFAULT 1,
  updated_by  uuid REFERENCES operators (id),
  created_at  timestamptz       NOT NULL DEFAULT now(),
  updated_at  timestamptz       NOT NULL DEFAULT now(),
  CONSTRAINT routing_rules_type_key UNIQUE (vertical_id, type),
  -- Deferrable so two rankers can swap places inside one statement sequence.
  CONSTRAINT routing_rules_position_key UNIQUE (vertical_id, kind, position) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT routing_rules_type_kind_chk CHECK (
    (kind = 'filter'  AND type IN ('working_hours')) OR
    (kind = 'limiter' AND type IN ('daily_cap', 'monthly_cap')) OR
    (kind = 'ranker'  AND type IN ('priority', 'weighted_fairness', 'least_recently_assigned'))
  )
);
CREATE TRIGGER routing_rules_set_updated_at BEFORE UPDATE ON routing_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Why did this lead go to this business? One row per attempt, never edited: the rules as they were, every candidate's verdict, the
-- price, how long it took. "Explain" in the admin and the real router run the same decision code, so the two cannot disagree.
CREATE TABLE routing_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           uuid            NOT NULL REFERENCES leads (id),
  outcome           routing_outcome NOT NULL,
  rules             jsonb           NOT NULL,
  algorithm_version text            NOT NULL,
  candidates        jsonb           NOT NULL DEFAULT '[]'::jsonb,
  chosen_client_id  uuid REFERENCES clients (id),
  price_pence       integer CHECK (price_pence >= 0),
  error             text CHECK (char_length(error) <= 200),
  duration_ms       integer CHECK (duration_ms >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routing_runs_chosen_chk CHECK ((outcome = 'assigned') = (chosen_client_id IS NOT NULL))
);
CREATE INDEX routing_runs_lead_idx ON routing_runs (lead_id, created_at DESC);
CREATE INDEX routing_runs_created_idx ON routing_runs (created_at DESC);
CREATE TRIGGER routing_runs_append_only BEFORE UPDATE OR DELETE ON routing_runs FOR EACH ROW EXECUTE FUNCTION forbid_modification();

ALTER TABLE lead_assignments ADD COLUMN routing_run_id uuid REFERENCES routing_runs (id);
-- An automatic assignment is explained by a run and made by nobody; a manual one is the other way round (0003's own check).
ALTER TABLE lead_assignments ADD CONSTRAINT lead_assignments_router_has_run_chk
  CHECK (assigned_by <> 'router' OR (routing_run_id IS NOT NULL AND assigned_by_user_id IS NULL));

-- ---------------------------------------------------------------------------------------------------
-- The router's view of a lead
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE leads ADD COLUMN routing_attempted_at timestamptz;
-- A lead that found nobody (`new` -> `unroutable`) is a legal move now.
INSERT INTO lead_status_transitions (from_status, to_status) VALUES ('new', 'unroutable');
-- The router's work queue: oldest first. Partial, so it stays tiny whatever the history grows to.
CREATE INDEX leads_routable_idx ON leads (created_at) WHERE status IN ('new', 'unroutable') AND deleted_at IS NULL AND NOT is_test;

-- ---------------------------------------------------------------------------------------------------
-- Waking the router. NOTIFY is only an accelerator (the worker also polls), and it is delivered at COMMIT, so the router never
-- wakes for something it cannot yet see.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION notify_routing_due() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('routing_due', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER leads_notify_routing_insert AFTER INSERT ON leads
  FOR EACH ROW WHEN (NEW.status = 'new') EXECUTE FUNCTION notify_routing_due();
CREATE TRIGGER leads_notify_routing_update AFTER UPDATE OF status ON leads
  FOR EACH ROW WHEN (NEW.status = 'new' AND OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION notify_routing_due();

-- Anything the router's answer depends on changed: let leads that found nobody be looked at again NOW. This deliberately touches
-- ONE settings row and never a lead row: lead rows are locked by the router before client rows, and a client edit holds a client
-- row, so locking leads here could deadlock the two.
CREATE FUNCTION routing_poke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE routing_settings SET poked_at = now();
  PERFORM pg_notify('routing_due', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER clients_poke_routing                AFTER INSERT OR UPDATE OR DELETE ON clients                FOR EACH STATEMENT EXECUTE FUNCTION routing_poke();
CREATE TRIGGER client_services_poke_routing        AFTER INSERT OR UPDATE OR DELETE ON client_services        FOR EACH STATEMENT EXECUTE FUNCTION routing_poke();
CREATE TRIGGER client_service_areas_poke_routing   AFTER INSERT OR UPDATE OR DELETE ON client_service_areas   FOR EACH STATEMENT EXECUTE FUNCTION routing_poke();
CREATE TRIGGER pricing_rules_poke_routing          AFTER INSERT OR UPDATE OR DELETE ON pricing_rules          FOR EACH STATEMENT EXECUTE FUNCTION routing_poke();
CREATE TRIGGER client_working_hours_poke_routing   AFTER INSERT OR UPDATE OR DELETE ON client_working_hours   FOR EACH STATEMENT EXECUTE FUNCTION routing_poke();
CREATE TRIGGER client_pauses_poke_routing          AFTER INSERT OR UPDATE OR DELETE ON client_pauses          FOR EACH STATEMENT EXECUTE FUNCTION routing_poke();
CREATE TRIGGER routing_rules_poke_routing          AFTER INSERT OR UPDATE OR DELETE ON routing_rules          FOR EACH STATEMENT EXECUTE FUNCTION routing_poke();

-- ---------------------------------------------------------------------------------------------------
-- Least privilege. Hours and pauses are configuration (audited), so they may be deleted; runs are evidence and are insert-only.
-- ---------------------------------------------------------------------------------------------------
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON routing_settings TO leadgen_app;
    GRANT SELECT, UPDATE         ON routing_rules    TO leadgen_app;
    GRANT SELECT, INSERT         ON routing_runs     TO leadgen_app;
    GRANT SELECT, INSERT, DELETE ON client_working_hours, client_pauses TO leadgen_app;
  END IF;
END
$grants$;
