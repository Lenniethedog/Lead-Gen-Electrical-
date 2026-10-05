-- Up Migration
-- =====================================================================================================
-- 0013_change_requests — Stage 6, slice 5: a business can SEE where and what it covers, and ask staff to change it.
--
--   client_change_requests   "please change my coverage / services" from a business; staff mark it done. A business cannot edit its own
--                            coverage (it decides what leads cost and who is sold what, and routing depends on it): staff do, with an audit.
--   row-level security       on client_services and client_service_areas, so the new read-only page is held to the same rule as the rest of the
--                            dashboard (a business reads only its own rows)
--
-- Roll-forward only.
-- =====================================================================================================

CREATE TYPE change_request_kind   AS ENUM ('coverage', 'services', 'other');
CREATE TYPE change_request_status AS ENUM ('open', 'done');

CREATE TABLE client_change_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id    uuid NOT NULL REFERENCES clients (id),
  kind         change_request_kind NOT NULL,
  message      text NOT NULL CHECK (char_length(message) BETWEEN 5 AND 1000),
  status       change_request_status NOT NULL DEFAULT 'open',
  requested_by uuid NOT NULL REFERENCES client_users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  done_by      uuid REFERENCES operators (id),
  done_at      timestamptz,
  CONSTRAINT change_requests_done_chk CHECK ((status = 'done') = (done_at IS NOT NULL AND done_by IS NOT NULL))
);
CREATE INDEX change_requests_open_idx ON client_change_requests (created_at) WHERE status = 'open';
CREATE INDEX change_requests_client_idx ON client_change_requests (client_id, created_at DESC);

ALTER TABLE client_change_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY change_requests_tenant ON client_change_requests USING (app_client_id() IS NULL OR client_id = app_client_id());

-- Read-only for a business: the policies let staff, the router and the worker (no scope) through unchanged.
ALTER TABLE client_services ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_services_tenant ON client_services USING (app_client_id() IS NULL OR client_id = app_client_id());
ALTER TABLE client_service_areas ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_service_areas_tenant ON client_service_areas USING (app_client_id() IS NULL OR client_id = app_client_id());

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON client_change_requests TO leadgen_app;
  END IF;
END
$grants$;
