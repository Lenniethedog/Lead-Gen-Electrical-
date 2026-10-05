-- Up Migration
-- =====================================================================================================
-- 0003_clients_and_assignments — Stage 3: who buys leads, where they work, who holds which lead, and the
-- audit trail and privacy records that make doing this by hand safe.
--
--   clients, client_services, client_service_areas   the businesses, what they do, where they cover
--   pricing_rules                                    flat prices (history is immutable)
--   leads.sale_model / max_assignments / count       a lead commits to one sale model and a recipient cap
--   lead_assignments (+ transitions, history)        who holds a lead; the double-sale guard lives here
--   suppressions                                     keyed hashes of people we must not contact again
--   audit_logs                                       append-only record of every staff mutation
--
-- Cut from docs/design/target-schema.sql, which keeps the stage 4+ remainder. Deferred on purpose (they
-- belong to routing, stage 4): client priority/weight/caps/timezone, working hours, pauses, routing_run_id.
-- Staff are `operators` (stage 2); a client-login `users` table arrives with client logins (stage 6).
-- Roll-forward only.
-- =====================================================================================================

CREATE TYPE client_status      AS ENUM ('prospect', 'active', 'paused', 'suspended', 'churned');
CREATE TYPE coverage_kind      AS ENUM ('outward', 'sector', 'postcode_prefix', 'area', 'radius');
CREATE TYPE coverage_mode      AS ENUM ('include', 'exclude');
CREATE TYPE sale_type          AS ENUM ('exclusive', 'shared');
CREATE TYPE assignment_status  AS ENUM (
  'reserved', 'notified', 'accepted', 'disputed',          -- ACTIVE: the lead is spoken for
  'rejected', 'refunded', 'expired', 'cancelled', 'delivery_failed'  -- ended: the lead is free again
);
CREATE TYPE assigned_by        AS ENUM ('router', 'staff');
CREATE TYPE suppression_kind   AS ENUM ('phone', 'email');
CREATE TYPE suppression_reason AS ENUM ('erasure', 'withdrawn_consent', 'opt_out', 'tps');

-- ---------------------------------------------------------------------------------------------------
-- Clients
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_id        integer NOT NULL REFERENCES verticals (id),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  legal_name         text CHECK (char_length(legal_name) <= 200),
  company_number     text CHECK (char_length(company_number) <= 20),
  status             client_status NOT NULL DEFAULT 'prospect',
  -- Who leads are sent to. Business contact details, not consumer data.
  contact_name       text CHECK (char_length(contact_name) <= 100),
  contact_email      text NOT NULL CHECK (char_length(contact_email) <= 254 AND contact_email = lower(contact_email)),
  contact_phone_e164 text CHECK (contact_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  accepts_exclusive  boolean NOT NULL DEFAULT true,
  accepts_shared     boolean NOT NULL DEFAULT false,
  notes              text CHECK (char_length(notes) <= 2000),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  CONSTRAINT clients_accepts_something_chk CHECK (accepts_exclusive OR accepts_shared)
);
CREATE INDEX clients_vertical_status_idx ON clients (vertical_id, status) WHERE deleted_at IS NULL;
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE client_services (
  client_id       uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  service_type_id integer NOT NULL REFERENCES service_types (id),
  PRIMARY KEY (client_id, service_type_id)
);

-- Coverage rules. Eligibility = (any active INCLUDE rule matches) AND (no active EXCLUDE rule matches).
CREATE TABLE client_service_areas (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  mode            coverage_mode NOT NULL DEFAULT 'include',
  kind            coverage_kind NOT NULL,
  outward         text CHECK (outward ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'),
  sector          text CHECK (sector ~ '^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9]$'),
  postcode_prefix text CHECK (postcode_prefix ~ '^[A-Z]{1,2}[0-9A-Z ]{0,6}$'),
  service_area_id integer REFERENCES service_areas (id),
  center_postcode text REFERENCES postcodes (postcode),
  radius_m        integer,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Exactly the fields of ONE kind are populated. (Every required field is tested IS NOT NULL explicitly:
  -- a bare `x BETWEEN ...` is NULL, not false, when x is NULL, and a CHECK treats NULL as passing.)
  CONSTRAINT client_service_areas_shape_chk CHECK (
    (kind = 'outward'         AND outward IS NOT NULL         AND num_nonnulls(sector, postcode_prefix, service_area_id, center_postcode, radius_m) = 0) OR
    (kind = 'sector'          AND sector IS NOT NULL          AND num_nonnulls(outward, postcode_prefix, service_area_id, center_postcode, radius_m) = 0) OR
    (kind = 'postcode_prefix' AND postcode_prefix IS NOT NULL AND num_nonnulls(outward, sector, service_area_id, center_postcode, radius_m) = 0) OR
    (kind = 'area'            AND service_area_id IS NOT NULL AND num_nonnulls(outward, sector, postcode_prefix, center_postcode, radius_m) = 0) OR
    (kind = 'radius'          AND center_postcode IS NOT NULL AND radius_m IS NOT NULL AND radius_m BETWEEN 500 AND 100000
                              AND num_nonnulls(outward, sector, postcode_prefix, service_area_id) = 0)
  )
);
-- One index per rule kind keeps eligibility lookups index-only for the common cases.
CREATE INDEX csa_outward_idx ON client_service_areas (outward)         WHERE kind = 'outward' AND active;
CREATE INDEX csa_sector_idx  ON client_service_areas (sector)          WHERE kind = 'sector' AND active;
CREATE INDEX csa_area_idx    ON client_service_areas (service_area_id) WHERE kind = 'area' AND active;
CREATE INDEX csa_radius_idx  ON client_service_areas (client_id)       WHERE kind = 'radius' AND active;
CREATE INDEX csa_client_idx  ON client_service_areas (client_id);
-- The same rule cannot be entered twice for a client.
CREATE UNIQUE INDEX csa_unique_rule ON client_service_areas (
  client_id, mode, kind, coalesce(outward, ''), coalesce(sector, ''), coalesce(postcode_prefix, ''),
  coalesce(service_area_id, 0), coalesce(center_postcode, ''), coalesce(radius_m, 0)
);

-- ---------------------------------------------------------------------------------------------------
-- Pricing (flat). An assignment snapshots its price, so history never changes retroactively.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE pricing_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vertical_id     integer NOT NULL REFERENCES verticals (id),
  service_type_id integer REFERENCES service_types (id),       -- NULL = any
  service_area_id integer REFERENCES service_areas (id),       -- NULL = anywhere
  urgency         urgency_level,                               -- NULL = any
  sale_type       sale_type NOT NULL,
  price_pence     integer NOT NULL CHECK (price_pence >= 0),
  currency        char(3) NOT NULL DEFAULT 'GBP',
  -- Most specific matching rule wins; ties broken by priority (higher wins), then newest.
  priority        smallint NOT NULL DEFAULT 0,
  valid_during    tstzrange NOT NULL DEFAULT tstzrange(now(), NULL),
  created_by      uuid REFERENCES operators (id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pricing_rules_lookup_idx ON pricing_rules (vertical_id, sale_type, service_type_id);

-- A price is never edited, only ended and replaced: the only change allowed is closing `valid_during`.
CREATE FUNCTION pricing_rules_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pricing rules are never deleted: end the rule instead' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - 'valid_during') IS DISTINCT FROM (to_jsonb(OLD) - 'valid_during')
     OR lower(NEW.valid_during) IS DISTINCT FROM lower(OLD.valid_during)
     OR (upper(OLD.valid_during) IS NOT NULL AND upper(NEW.valid_during) IS DISTINCT FROM upper(OLD.valid_during)) THEN
    RAISE EXCEPTION 'a pricing rule can only be ended, not edited: create a new rule' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER pricing_rules_guard BEFORE UPDATE OR DELETE ON pricing_rules FOR EACH ROW EXECUTE FUNCTION pricing_rules_guard();

-- ---------------------------------------------------------------------------------------------------
-- Assignments: the exclusivity core
-- ---------------------------------------------------------------------------------------------------
-- A lead commits to ONE sale model for life (set by the first assignment), and carries its own cap
-- on how many clients may hold it at once (never above what the consumer consented to).
ALTER TABLE leads ADD COLUMN sale_model        sale_type;
ALTER TABLE leads ADD COLUMN max_assignments   smallint NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN assignments_count smallint NOT NULL DEFAULT 0;
ALTER TABLE leads ADD CONSTRAINT leads_max_assignments_chk CHECK (max_assignments BETWEEN 1 AND 10);
ALTER TABLE leads ADD CONSTRAINT leads_assignments_within_cap_chk CHECK (assignments_count BETWEEN 0 AND max_assignments);
ALTER TABLE leads ADD CONSTRAINT leads_exclusive_means_one_chk CHECK (sale_model IS DISTINCT FROM 'exclusive' OR max_assignments = 1);
-- Target of the composite foreign key below.
ALTER TABLE leads ADD CONSTRAINT leads_id_sale_model_key UNIQUE (id, sale_model);

CREATE TABLE lead_assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL,
  client_id           uuid NOT NULL REFERENCES clients (id),
  sale_type           sale_type NOT NULL,
  status              assignment_status NOT NULL DEFAULT 'reserved',
  assigned_by         assigned_by NOT NULL,
  assigned_by_user_id uuid REFERENCES operators (id),
  price_pence         integer NOT NULL CHECK (price_pence >= 0),
  currency            char(3) NOT NULL DEFAULT 'GBP',
  pricing_rule_id     uuid REFERENCES pricing_rules (id),
  respond_by          timestamptz,
  reserved_at         timestamptz NOT NULL DEFAULT now(),
  notified_at         timestamptz,
  accepted_at         timestamptz,
  rejected_at         timestamptz,
  rejection_reason    text CHECK (char_length(rejection_reason) <= 500),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- THE EXCLUSIVITY LINK: an assignment's sale_type must equal the sale_model its lead committed to.
  -- The assigner must set leads.sale_model first; changing it while assignments exist is impossible.
  CONSTRAINT lead_assignments_lead_model_fk FOREIGN KEY (lead_id, sale_type)
    REFERENCES leads (id, sale_model) ON UPDATE RESTRICT ON DELETE RESTRICT,
  CONSTRAINT lead_assignments_manual_has_actor_chk CHECK (assigned_by <> 'staff' OR assigned_by_user_id IS NOT NULL)
);

-- "Active" = reserved | notified | accepted | disputed. These two indexes ARE the double-sale guard.
-- 1. A client can never hold the same lead twice at once.
CREATE UNIQUE INDEX lead_assignments_one_active_per_client ON lead_assignments (lead_id, client_id)
  WHERE status IN ('reserved', 'notified', 'accepted', 'disputed');
-- 2. An EXCLUSIVE lead has at most one active assignment, no matter how many assigners race.
CREATE UNIQUE INDEX lead_assignments_one_active_exclusive ON lead_assignments (lead_id)
  WHERE sale_type = 'exclusive' AND status IN ('reserved', 'notified', 'accepted', 'disputed');
CREATE INDEX lead_assignments_client_idx ON lead_assignments (client_id, created_at DESC);
CREATE INDEX lead_assignments_lead_idx ON lead_assignments (lead_id, created_at DESC);
CREATE INDEX lead_assignments_respond_by_idx ON lead_assignments (respond_by) WHERE status IN ('reserved', 'notified');
CREATE TRIGGER lead_assignments_set_updated_at BEFORE UPDATE ON lead_assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keeps leads.assignments_count equal to the number of ACTIVE assignments, so the cap on shared
-- leads is enforced by leads_assignments_within_cap_chk. The explicit row lock is essential: it makes
-- concurrent assignments for one lead queue up, and because the COUNT is a separate statement it
-- takes its snapshot only AFTER the lock is held, so it sees the previous winner's committed row.
-- FOR NO KEY UPDATE (not FOR UPDATE): the foreign-key check on the INSERT already holds a KEY SHARE
-- lock on the lead, and FOR UPDATE would conflict with the OTHER transaction's KEY SHARE, producing a
-- lock-upgrade deadlock. NO KEY UPDATE still serialises writers against each other.
CREATE FUNCTION sync_lead_assignments_count() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM leads WHERE id = NEW.lead_id FOR NO KEY UPDATE;
  UPDATE leads SET assignments_count = (
    SELECT count(*) FROM lead_assignments a
    WHERE a.lead_id = NEW.lead_id AND a.status IN ('reserved', 'notified', 'accepted', 'disputed')
  ) WHERE id = NEW.lead_id;
  RETURN NULL;
END
$$;
CREATE TRIGGER lead_assignments_sync_count AFTER INSERT OR UPDATE OF status ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION sync_lead_assignments_count();

-- Assignment lifecycle, enforced like the lead lifecycle (lead_status_transitions, migration 0001).
-- The five ENDED statuses are terminal: ending an assignment frees the lead, it never reopens.
CREATE TABLE assignment_status_transitions (
  from_status assignment_status NOT NULL,
  to_status   assignment_status NOT NULL,
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status <> to_status)
);
INSERT INTO assignment_status_transitions (from_status, to_status) VALUES
  ('reserved', 'notified'), ('reserved', 'delivery_failed'), ('reserved', 'cancelled'), ('reserved', 'expired'),
  ('notified', 'accepted'), ('notified', 'rejected'), ('notified', 'expired'), ('notified', 'cancelled'), ('notified', 'disputed'),
  ('accepted', 'disputed'),
  ('disputed', 'refunded'), ('disputed', 'accepted');

CREATE FUNCTION enforce_assignment_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM assignment_status_transitions t WHERE t.from_status = OLD.status AND t.to_status = NEW.status
  ) THEN
    RAISE EXCEPTION 'illegal assignment status transition: % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER lead_assignments_enforce_transition BEFORE UPDATE OF status ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_assignment_status_transition();

CREATE TABLE lead_assignment_status_history (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  assignment_id uuid NOT NULL REFERENCES lead_assignments (id),
  from_status   assignment_status,
  to_status     assignment_status NOT NULL,
  actor_type    actor_type NOT NULL,
  actor_id      uuid,
  reason        text CHECK (char_length(reason) <= 500),
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status IS DISTINCT FROM to_status)
);
CREATE INDEX assignment_history_idx ON lead_assignment_status_history (assignment_id, id);
CREATE TRIGGER assignment_history_append_only BEFORE UPDATE OR DELETE ON lead_assignment_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- Same pattern as lead_status_history: SECURITY DEFINER, so the application role can only create history
-- through this trigger. Context comes from transaction-local settings (app.actor_type / actor_id / reason / request_id).
CREATE FUNCTION record_assignment_status_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_type actor_type := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system')::actor_type;
  v_actor_id   uuid       := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_reason     text       := nullif(current_setting('app.reason', true), '');
  v_request_id text       := nullif(current_setting('app.request_id', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lead_assignment_status_history (assignment_id, from_status, to_status, actor_type, actor_id, reason, request_id)
    VALUES (NEW.id, NULL, NEW.status, v_actor_type, v_actor_id, v_reason, v_request_id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO lead_assignment_status_history (assignment_id, from_status, to_status, actor_type, actor_id, reason, request_id)
    VALUES (NEW.id, OLD.status, NEW.status, v_actor_type, v_actor_id, v_reason, v_request_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER lead_assignments_record_history AFTER INSERT OR UPDATE OF status ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION record_assignment_status_history();

-- A manual assignment must be attributable and justified, like a held-lead decision (migration 0002):
-- ending an assignment by hand (cancelled / rejected) needs a staff actor and a reason in the transaction.
CREATE FUNCTION enforce_assignment_end_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('cancelled', 'rejected') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF coalesce(current_setting('app.actor_type', true), '') NOT IN ('staff_user', 'system')
       OR (current_setting('app.actor_type', true) = 'staff_user'
           AND (nullif(current_setting('app.actor_id', true), '') IS NULL OR nullif(current_setting('app.reason', true), '') IS NULL)) THEN
      RAISE EXCEPTION 'ending an assignment needs an actor and, for staff, a reason'
        USING ERRCODE = 'check_violation',
              HINT = 'set app.actor_type, and for staff_user also app.actor_id and app.reason, in the transaction';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER lead_assignments_enforce_end_actor BEFORE UPDATE OF status ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_assignment_end_actor();

-- ---------------------------------------------------------------------------------------------------
-- Consent is enforced where the assignment is made, not just in the application (docs/04, D9):
--   * the lead's consent must allow sharing with at least one business (first-party consent allows none),
--   * consent must not have been withdrawn, and the lead must not be erased or deleted,
--   * a lead's recipient cap can never be raised above what the consumer consented to.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION consent_max_recipients(p_lead_id uuid) RETURNS smallint
LANGUAGE sql STABLE AS $$
  SELECT t.max_recipients
    FROM consent_records r JOIN consent_texts t ON t.id = r.consent_text_id
   WHERE r.lead_id = p_lead_id AND r.event = 'granted'
   ORDER BY r.captured_at LIMIT 1
$$;

CREATE FUNCTION enforce_assignment_consent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(consent_max_recipients(NEW.lead_id), 0) < 1 THEN
    RAISE EXCEPTION 'lead % has no consent to be shared with a business', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM consent_records r WHERE r.lead_id = NEW.lead_id AND r.event = 'withdrawn') THEN
    RAISE EXCEPTION 'consent for lead % was withdrawn', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM leads l WHERE l.id = NEW.lead_id AND (l.erased_at IS NOT NULL OR l.deleted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'lead % was erased or deleted', NEW.lead_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER lead_assignments_enforce_consent BEFORE INSERT ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_assignment_consent();

CREATE FUNCTION enforce_lead_cap_within_consent() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.max_assignments > coalesce(consent_max_recipients(NEW.id), 0) THEN
    RAISE EXCEPTION 'lead % may be shared with at most % business(es) (what the consumer consented to), not %',
      NEW.id, coalesce(consent_max_recipients(NEW.id), 0), NEW.max_assignments USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leads_enforce_cap_within_consent BEFORE UPDATE OF max_assignments ON leads
  FOR EACH ROW WHEN (NEW.max_assignments IS DISTINCT FROM OLD.max_assignments) EXECUTE FUNCTION enforce_lead_cap_within_consent();

-- A lead marked `assigned` must be held by someone: checked at COMMIT, so the status change and the assignment
-- can be written in either order inside one transaction. (The reverse drift, held but not marked, is harmless: the
-- unique indexes above still prevent a second sale.)
CREATE FUNCTION assert_assigned_lead_has_assignment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status lead_status;
  v_count  smallint;
BEGIN
  SELECT status, assignments_count INTO v_status, v_count FROM leads WHERE id = NEW.id;
  IF v_status = 'assigned' AND v_count = 0 THEN
    RAISE EXCEPTION 'lead % is marked assigned but no business holds it', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER leads_assigned_requires_assignment AFTER INSERT OR UPDATE OF status, assignments_count ON leads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_assigned_lead_has_assignment();

-- ---------------------------------------------------------------------------------------------------
-- Privacy records and the audit trail
-- ---------------------------------------------------------------------------------------------------
-- After erasure or an opt-out we must remember WHO not to contact, without remembering who they are.
-- value_hmac is HMAC-SHA256 with a secret key held in the platform's secret store (PRIVACY_HASH_KEY): a plain hash of a
-- phone number is reversible by trying every number, so a bare SHA-256 would not "forget" anyone.
CREATE TABLE suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        suppression_kind NOT NULL,
  value_hmac  text NOT NULL CHECK (value_hmac ~ '^[0-9a-f]{64}$'),
  reason      suppression_reason NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value_hmac)
);

CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_type  actor_type NOT NULL,
  actor_id    uuid,
  action      text NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z_]+$'),
  entity_id   text NOT NULL CHECK (char_length(entity_id) <= 100),
  reason      text CHECK (char_length(reason) <= 1000),
  -- Business facts only: NEVER personal data about a consumer (docs/04). Tested.
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text CHECK (char_length(user_agent) <= 512),
  request_id  text CHECK (char_length(request_id) <= 100)
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, id);
CREATE INDEX audit_logs_actor_idx  ON audit_logs (actor_id, id) WHERE actor_id IS NOT NULL;
CREATE INDEX audit_logs_time_idx   ON audit_logs (occurred_at);
CREATE TRIGGER audit_logs_append_only BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------------------------------------------------------------------------------------------------
-- Least privilege. Coverage rules and service lists are configuration (changes are audited), so rows may be
-- deleted; everything that is evidence stays insert-only.
-- ---------------------------------------------------------------------------------------------------
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT SELECT, INSERT, UPDATE         ON clients                        TO leadgen_app;
    GRANT SELECT, INSERT, DELETE         ON client_services, client_service_areas TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE         ON pricing_rules                  TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE         ON lead_assignments               TO leadgen_app;
    GRANT SELECT                         ON assignment_status_transitions, lead_assignment_status_history TO leadgen_app;
    GRANT SELECT, INSERT                 ON suppressions, audit_logs       TO leadgen_app;
  END IF;
END
$grants$;
