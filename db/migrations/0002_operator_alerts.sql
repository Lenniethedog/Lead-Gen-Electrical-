-- Up Migration
-- =====================================================================================================
-- 0002_operator_alerts — Stage 2: tell a human about every lead that needs one, and never lose that fact.
--
--   operator_alerts          transactional outbox: one row per (lead, kind) is written in the SAME
--                            transaction as the lead, so "lead stored but nobody told" cannot happen.
--                            The row is both the work item and the audit record (docs/03 lifecycle).
--   operator_alert_attempts  append-only record of every send attempt (outcome, error code, latency).
--   operators                the staff people behind Cloudflare Access; gives staff actions a stable
--                            uuid for lead_status_history.actor_id. Superseded by `users` in stage 3.
--   worker_heartbeats        proves the worker is alive (read by /api/pipeline); not evidence.
--
-- Nothing here stores consumer personal data. Alerts reference a lead by id; the message is built at
-- send time and carries no contact details (see src/modules/alerts/message.ts).
-- Roll-forward only: fix mistakes with a new migration.
-- =====================================================================================================

CREATE TYPE operator_alert_kind   AS ENUM (
  'new_lead',   -- a lead was accepted and is waiting for a human
  'held_lead',  -- the fraud score put the lead in the review band: a human must approve or reject it
  'reminder'    -- the lead is still unhandled after the reminder delay (sent once per lead)
);
CREATE TYPE operator_alert_status AS ENUM (
  'pending',    -- created, not yet tried
  'sending',    -- claimed by a worker (locked_until = lease)
  'retrying',   -- last attempt failed in a way worth retrying; next_attempt_at says when
  'sent',       -- the provider accepted it
  'dead',       -- attempts exhausted or a permanent failure: needs a human (reported by /api/pipeline)
  'cancelled'   -- no longer needed (the lead was handled or decided before a reminder went out)
);

-- ---------------------------------------------------------------------------------------------------
-- Operators
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE operators (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------
-- The alert outbox
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE operator_alerts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             uuid NOT NULL REFERENCES leads (id) ON DELETE RESTRICT,
  kind                operator_alert_kind NOT NULL,
  status              operator_alert_status NOT NULL DEFAULT 'pending',
  attempt_count       smallint NOT NULL DEFAULT 0,
  max_attempts        smallint NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  -- The lease: a worker owns a 'sending' row until this passes; the reconciler reclaims it after.
  locked_until        timestamptz,
  last_error_code     text CHECK (char_length(last_error_code) <= 100),
  provider_message_id text CHECK (char_length(provider_message_id) <= 200),
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Idempotent creation: however many times the enqueue is retried (replays, the reconciler racing
  -- the request), a lead gets at most one alert of each kind.
  UNIQUE (lead_id, kind),
  CONSTRAINT operator_alerts_attempts_chk CHECK (attempt_count BETWEEN 0 AND max_attempts),
  CONSTRAINT operator_alerts_sent_chk     CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT operator_alerts_lease_chk    CHECK ((status = 'sending') = (locked_until IS NOT NULL))
);
CREATE INDEX operator_alerts_due_idx   ON operator_alerts (next_attempt_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX operator_alerts_stuck_idx ON operator_alerts (locked_until)    WHERE status = 'sending';
CREATE INDEX operator_alerts_dead_idx  ON operator_alerts (updated_at)      WHERE status = 'dead';
CREATE TRIGGER operator_alerts_set_updated_at BEFORE UPDATE ON operator_alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per finished attempt (written once, never edited). A crash leaves no row of its own: the
-- reconciler records the lost attempt as 'abandoned' when it reclaims the lease.
CREATE TABLE operator_alert_attempts (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id    uuid NOT NULL REFERENCES operator_alerts (id) ON DELETE RESTRICT,
  attempt_no  smallint NOT NULL CHECK (attempt_no >= 1),
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  outcome     text NOT NULL CHECK (outcome IN ('accepted', 'retryable_failure', 'permanent_failure', 'timeout', 'abandoned')),
  error_code  text CHECK (char_length(error_code) <= 100),
  http_status smallint,
  latency_ms  integer CHECK (latency_ms >= 0),
  -- A zombie worker finishing after the reconciler reclaimed its lease cannot record a second row
  -- for the same attempt number.
  UNIQUE (alert_id, attempt_no)
);
CREATE TRIGGER operator_alert_attempts_append_only BEFORE UPDATE OR DELETE ON operator_alert_attempts
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------------------------------------------------------------------------------------------------
-- Worker liveness
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE worker_heartbeats (
  worker_id         text PRIMARY KEY CHECK (char_length(worker_id) BETWEEN 1 AND 100),
  started_at        timestamptz NOT NULL DEFAULT now(),
  last_beat_at      timestamptz NOT NULL DEFAULT now(),
  last_reconciled_at timestamptz
);

-- ---------------------------------------------------------------------------------------------------
-- A human decision on a held lead must be made by a human, with a reason.
-- Approving (held -> new) or rejecting (held -> rejected_fraud) is the one place where a person
-- overrides the automated screen, so the database refuses it unless the transaction says WHO and WHY
-- (app.actor_type / app.actor_id / app.reason, the same context that feeds lead_status_history).
-- Automated transitions out of 'held' (e.g. expiry by a sweeper) are unaffected.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION enforce_held_review_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'held' AND NEW.status IN ('new', 'rejected_fraud') THEN
    IF coalesce(current_setting('app.actor_type', true), '') <> 'staff_user'
       OR nullif(current_setting('app.actor_id', true), '') IS NULL
       OR nullif(current_setting('app.reason', true), '') IS NULL THEN
      RAISE EXCEPTION 'reviewing a held lead requires a staff actor and a reason'
        USING ERRCODE = 'check_violation',
              HINT = 'set app.actor_type = staff_user, app.actor_id and app.reason in the transaction';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leads_enforce_held_review_actor BEFORE UPDATE OF status ON leads
  FOR EACH ROW EXECUTE FUNCTION enforce_held_review_actor();

-- ---------------------------------------------------------------------------------------------------
-- Least privilege: the application role gets only what stage 2 needs. No DELETE on anything that is
-- evidence; heartbeats are operational noise and may be pruned.
-- ---------------------------------------------------------------------------------------------------
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT SELECT, INSERT         ON operators                TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE ON operator_alerts          TO leadgen_app;
    GRANT SELECT, INSERT         ON operator_alert_attempts  TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeats TO leadgen_app;
  END IF;
END
$grants$;
