-- Up Migration
-- =====================================================================================================
-- 0006_delivery — Stage 5: tell the business about its lead, automatically, and never lose that fact.
--
--   clients.delivery_*, notify_*, webhook_*   how a business wants to be told (OFF by default: `manual`)
--   notifications                             the delivery outbox: one row per (assignment, channel), written by a trigger
--                                             in the SAME transaction as the assignment, so "assigned but nobody told" cannot
--                                             happen for a business on automatic delivery. Work item AND audit record.
--   notification_attempts                     append-only record of every attempt (outcome, error code, latency)
--   provider_events                           provider callbacks (Twilio status), processed once each
--
-- Nothing here stores consumer personal data. A notification references an assignment by id; the message is built at send time.
-- A business's own contact details and webhook URL are business data. The webhook signing secret is stored ENCRYPTED
-- (AES-256-GCM, key in the environment): it must be recoverable to sign, so a hash would not do.
-- Deliberately not here: a canary lead (the health checks in /api/pipeline are the stuck-pipeline signal), per-channel fallback ordering
-- (every enabled channel is sent at once), WhatsApp. See docs/00 D35-D41. Roll-forward only.
-- =====================================================================================================

CREATE TYPE delivery_mode        AS ENUM ('manual', 'automatic');
CREATE TYPE notification_channel AS ENUM ('email', 'sms', 'webhook');
CREATE TYPE notification_status  AS ENUM (
  'pending',    -- created, not yet tried
  'sending',    -- claimed by a worker (locked_until = lease)
  'retrying',   -- last attempt failed in a way worth retrying
  'sent',       -- the provider accepted it
  'delivered',  -- the provider confirmed delivery (SMS status callback)
  'failed',     -- permanent failure, or the provider reported it undelivered
  'dead',       -- attempts exhausted: needs a human
  'cancelled'   -- no longer wanted (the assignment ended, consent was withdrawn)
);

-- ---------------------------------------------------------------------------------------------------
-- How a business wants to be told
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE clients
  ADD COLUMN delivery_mode        delivery_mode NOT NULL DEFAULT 'manual',
  ADD COLUMN delivery_enabled_at  timestamptz,
  ADD COLUMN notify_email         boolean NOT NULL DEFAULT true,
  ADD COLUMN notify_sms           boolean NOT NULL DEFAULT false,
  ADD COLUMN notify_webhook       boolean NOT NULL DEFAULT false,
  ADD COLUMN webhook_url          text,
  ADD COLUMN webhook_secret_enc   text,
  ADD COLUMN webhook_secret_hint  text,
  ADD COLUMN webhook_failing_since timestamptz;
ALTER TABLE clients
  ADD CONSTRAINT clients_webhook_url_chk CHECK (webhook_url IS NULL OR (webhook_url ~ '^https://[^/\s]+' AND char_length(webhook_url) <= 500)),
  ADD CONSTRAINT clients_webhook_ready_chk CHECK (NOT notify_webhook OR (webhook_url IS NOT NULL AND webhook_secret_enc IS NOT NULL)),
  ADD CONSTRAINT clients_sms_ready_chk CHECK (NOT notify_sms OR contact_phone_e164 IS NOT NULL),
  ADD CONSTRAINT clients_automatic_has_channel_chk CHECK (delivery_mode = 'manual' OR notify_email OR notify_sms OR notify_webhook),
  ADD CONSTRAINT clients_delivery_enabled_chk CHECK (delivery_mode = 'manual' OR delivery_enabled_at IS NOT NULL);

-- ---------------------------------------------------------------------------------------------------
-- The delivery outbox
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id       uuid NOT NULL REFERENCES lead_assignments (id) ON DELETE RESTRICT,
  channel             notification_channel NOT NULL,
  status              notification_status NOT NULL DEFAULT 'pending',
  attempt_count       smallint NOT NULL DEFAULT 0,
  max_attempts        smallint NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 20),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  locked_until        timestamptz,
  last_error_code     text CHECK (char_length(last_error_code) <= 100),
  provider_message_id text CHECK (char_length(provider_message_id) <= 200),
  sent_at             timestamptz,
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- Idempotent creation: however often the trigger fires or an insert is retried, one notification per channel per assignment.
  UNIQUE (assignment_id, channel),
  CONSTRAINT notifications_attempts_chk  CHECK (attempt_count BETWEEN 0 AND max_attempts),
  CONSTRAINT notifications_sent_chk      CHECK (status NOT IN ('sent', 'delivered') OR sent_at IS NOT NULL),
  CONSTRAINT notifications_delivered_chk CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT notifications_lease_chk     CHECK ((status = 'sending') = (locked_until IS NOT NULL))
);
CREATE INDEX notifications_due_idx    ON notifications (next_attempt_at) WHERE status IN ('pending', 'retrying');
CREATE INDEX notifications_stuck_idx  ON notifications (locked_until)    WHERE status = 'sending';
CREATE INDEX notifications_problem_idx ON notifications (updated_at)     WHERE status IN ('failed', 'dead');
CREATE INDEX notifications_provider_idx ON notifications (provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TRIGGER notifications_set_updated_at BEFORE UPDATE ON notifications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notification_attempts (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications (id) ON DELETE RESTRICT,
  attempt_no      smallint NOT NULL CHECK (attempt_no >= 1),
  started_at      timestamptz NOT NULL,
  finished_at     timestamptz NOT NULL DEFAULT now(),
  outcome         text NOT NULL CHECK (outcome IN ('accepted', 'retryable_failure', 'permanent_failure', 'timeout', 'abandoned')),
  error_code      text CHECK (char_length(error_code) <= 100),
  http_status     smallint,
  latency_ms      integer CHECK (latency_ms >= 0),
  UNIQUE (notification_id, attempt_no)
);
CREATE TRIGGER notification_attempts_append_only BEFORE UPDATE OR DELETE ON notification_attempts FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- Provider callbacks, each processed once. Holds the status and error code only: the callback body carries phone numbers, which are not kept.
CREATE TABLE provider_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider         text NOT NULL CHECK (provider ~ '^[a-z_]{1,30}$'),
  event_id         text NOT NULL CHECK (char_length(event_id) BETWEEN 1 AND 200),
  provider_message_id text CHECK (char_length(provider_message_id) <= 200),
  status           text NOT NULL CHECK (char_length(status) <= 40),
  error_code       text CHECK (char_length(error_code) <= 40),
  received_at      timestamptz NOT NULL DEFAULT now(),
  -- NULL until the event has been applied to a notification (a callback can arrive before we have recorded the message id).
  processed_at     timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX provider_events_unprocessed_idx ON provider_events (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------------------------------
-- Enqueue and cancel are triggers on the assignment, so EVERY path that assigns a lead (the router, an operator, a reassignment)
-- is covered, atomically, with no module having to remember. Only a business on `automatic` delivery gets notifications.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION enqueue_assignment_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c clients%ROWTYPE;
BEGIN
  IF NEW.status <> 'reserved' THEN RETURN NULL; END IF;
  SELECT * INTO c FROM clients WHERE id = NEW.client_id;
  IF c.delivery_mode <> 'automatic' THEN RETURN NULL; END IF;
  IF c.notify_email THEN
    INSERT INTO notifications (assignment_id, channel) VALUES (NEW.id, 'email') ON CONFLICT (assignment_id, channel) DO NOTHING;
  END IF;
  IF c.notify_sms THEN
    INSERT INTO notifications (assignment_id, channel) VALUES (NEW.id, 'sms') ON CONFLICT (assignment_id, channel) DO NOTHING;
  END IF;
  IF c.notify_webhook THEN
    INSERT INTO notifications (assignment_id, channel) VALUES (NEW.id, 'webhook') ON CONFLICT (assignment_id, channel) DO NOTHING;
  END IF;
  PERFORM pg_notify('notifications_due', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER lead_assignments_enqueue_notifications AFTER INSERT ON lead_assignments
  FOR EACH ROW EXECUTE FUNCTION enqueue_assignment_notifications();

-- When an assignment ends, notifications that have not gone out are not wanted. One that is in flight is allowed to finish (it cannot be recalled).
CREATE FUNCTION cancel_assignment_notifications() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE notifications SET status = 'cancelled', locked_until = NULL
   WHERE assignment_id = NEW.id AND status IN ('pending', 'retrying');
  RETURN NULL;
END
$$;
CREATE TRIGGER lead_assignments_cancel_notifications AFTER UPDATE OF status ON lead_assignments
  FOR EACH ROW WHEN (NEW.status IN ('cancelled', 'rejected', 'refunded', 'expired', 'delivery_failed'))
  EXECUTE FUNCTION cancel_assignment_notifications();

-- A retried notification (an operator pressed "try again") also wakes the worker.
CREATE FUNCTION notify_notifications_due() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('notifications_due', '');
  RETURN NULL;
END
$$;
CREATE TRIGGER notifications_notify_retry AFTER UPDATE OF status ON notifications
  FOR EACH ROW WHEN (NEW.status = 'pending' AND OLD.status IN ('failed', 'dead')) EXECUTE FUNCTION notify_notifications_due();

-- ---------------------------------------------------------------------------------------------------
-- Least privilege
-- ---------------------------------------------------------------------------------------------------
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON notifications         TO leadgen_app;
    GRANT SELECT, INSERT         ON notification_attempts TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE ON provider_events       TO leadgen_app;
  END IF;
END
$grants$;
