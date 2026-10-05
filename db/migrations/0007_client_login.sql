-- Up Migration
-- =====================================================================================================
-- 0007_client_login — Stage 6, slice 1: a business's people can sign in, and see only their own leads.
--
--   client_users          who may sign in for a business (one email belongs to ONE business: docs/00 D44)
--   client_login_tokens   single-use sign-in links: only a SHA-256 of the token is stored (D43)
--   client_sessions       signed-in browsers: only a SHA-256 of the cookie value is stored; re-checked on every request
--   app_client_id()       the business the current transaction is acting for, or NULL (staff, the worker, the router)
--   row-level security    on the tables a business can reach: with app.client_id set the database returns only that
--                         business's rows even if a query forgets its WHERE (D45). With it unset NOTHING changes.
--
-- No consumer personal data is stored here. A business user's name and email are business data. Roll-forward only.
-- =====================================================================================================

CREATE TYPE client_user_role   AS ENUM ('owner', 'manager', 'agent');
CREATE TYPE client_user_status AS ENUM ('invited', 'active', 'disabled');

CREATE TABLE client_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients (id),
  email         text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  role          client_user_role NOT NULL DEFAULT 'agent',
  status        client_user_status NOT NULL DEFAULT 'invited',
  invited_by    uuid REFERENCES operators (id),
  last_login_at timestamptz,
  disabled_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_users_disabled_chk CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);
-- One email, one business, for ever (a disabled person is re-enabled, not re-created): a sign-in link can only ever lead to one place.
CREATE UNIQUE INDEX client_users_email_key ON client_users (email);
CREATE INDEX client_users_client_idx ON client_users (client_id);
CREATE TRIGGER client_users_set_updated_at BEFORE UPDATE ON client_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE client_login_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES client_users (id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT client_login_tokens_expiry_chk CHECK (expires_at > created_at)
);
CREATE INDEX client_login_tokens_user_idx ON client_login_tokens (user_id, created_at DESC);

CREATE TABLE client_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES client_users (id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CONSTRAINT client_sessions_expiry_chk CHECK (expires_at > created_at)
);
CREATE INDEX client_sessions_user_idx ON client_sessions (user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------------------------------
-- Row-level security: which business is this transaction acting for?
--
-- The application sets it with `select set_config('app.client_id', <uuid>, true)` (transaction-local, via ONE helper).
-- A transaction-local setting reads back as '' (not NULL) in the same connection after the transaction ends, so '' means unset.
-- Unset = staff, the worker and the router: every policy below then allows everything, so no existing code path changes.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION app_client_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.client_id', true), '')::uuid $$;

-- A business sees its own assignments.
ALTER TABLE lead_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_assignments_tenant ON lead_assignments
  USING (app_client_id() IS NULL OR client_id = app_client_id());

-- A business sees the leads it holds or held, never any other.
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY leads_tenant ON leads
  USING (app_client_id() IS NULL OR EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = leads.id AND a.client_id = app_client_id()));

-- ...and a consumer's contact details only while it HOLDS the lead (reserved, notified, accepted, disputed): D46.
-- Two policies: staff keep full access; a business gets SELECT on held leads only (it can never write contact details).
ALTER TABLE lead_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lead_contacts_unscoped ON lead_contacts
  USING (app_client_id() IS NULL);
CREATE POLICY lead_contacts_holder ON lead_contacts FOR SELECT
  USING (EXISTS (SELECT 1 FROM lead_assignments a
                  WHERE a.lead_id = lead_contacts.lead_id AND a.client_id = app_client_id()
                    AND a.status IN ('reserved', 'notified', 'accepted', 'disputed')));

-- A business sees only itself.
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY clients_tenant ON clients
  USING (app_client_id() IS NULL OR id = app_client_id());

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT SELECT, INSERT, UPDATE         ON client_users        TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_login_tokens TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_sessions     TO leadgen_app;
  END IF;
END
$grants$;
