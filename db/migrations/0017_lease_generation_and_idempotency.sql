-- Up Migration
-- =====================================================================================================
-- 0017_lease_generation_and_idempotency — a claim token that a manual retry cannot reuse, and a
-- provider idempotency key that ordinary failures cannot roll back.
--
-- Resetting attempt_count on a manual retry made a new claim look like an old in-flight one, so a
-- worker that woke up late could complete the new attempt. lease_generation increments on every claim
-- and is never reset.
--
-- The idempotency key used to be derived from last_error_code. A payload mismatch rotated it, and the
-- next timeout wrote a different error code, which sent the following attempt back to the key the
-- provider had already rejected. The key is now a column of its own.
--
-- Roll-forward only. Table grants already cover the new columns.
-- =====================================================================================================

ALTER TABLE notifications
  ADD COLUMN lease_generation integer NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  ADD COLUMN provider_idempotency_key text CHECK (provider_idempotency_key IS NULL OR char_length(provider_idempotency_key) <= 200);

ALTER TABLE operator_alerts
  ADD COLUMN provider_idempotency_key text CHECK (provider_idempotency_key IS NULL OR char_length(provider_idempotency_key) <= 200);

COMMENT ON COLUMN notifications.lease_generation IS
  'Increments on every claim. Manual retry resets attempt_count but not this, so a stale worker cannot finish a later claim.';
COMMENT ON COLUMN notifications.provider_idempotency_key IS
  'Idempotency key for the next provider call. Set when a payload mismatch forces a new key; other failures leave it unchanged.';
COMMENT ON COLUMN operator_alerts.provider_idempotency_key IS
  'Idempotency key for the next provider call. Set when a payload mismatch forces a new key; other failures leave it unchanged.';

-- Erasure clears attribution text. Capture only inserted these rows; the app role needs UPDATE to blank them.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT UPDATE ON lead_attributions TO leadgen_app;
  END IF;
END
$grants$;
