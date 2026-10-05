-- Up Migration
-- =====================================================================================================
-- 0004_suppression_last_requested — a repeat request to stop must count.
--
-- suppressions is unique per (kind, value_hmac) so that recording the same person twice is harmless. But a person can ask us
-- to stop MORE THAN ONCE: erased in March, enquires again in June (fresh consent), withdraws that consent in July. With only
-- `created_at` (March), "did they ask us to stop since this lead was created?" would wrongly answer no for a lead made in June.
-- `last_requested_at` is the time of the most recent request; created_at remains the first.
-- =====================================================================================================
ALTER TABLE suppressions ADD COLUMN last_requested_at timestamptz NOT NULL DEFAULT now();
UPDATE suppressions SET last_requested_at = created_at;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    -- Column-level: the application may refresh the timestamp of an existing suppression, and nothing else about it.
    GRANT UPDATE (last_requested_at) ON suppressions TO leadgen_app;
  END IF;
END
$grants$;
