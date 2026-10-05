-- Creates the least-privilege role the web application connects as. Run ONCE per environment,
-- as an administrative user, BEFORE the first migration (migrations grant privileges to it):
--
--   psql "$ADMIN_DATABASE_URL" -v app_password="$(openssl rand -base64 32)" -f db/roles.sql
--
-- Then:
--   * run migrations/seeds with the OWNER credentials (DATABASE_MIGRATION_URL)
--   * run the application with the leadgen_app credentials (DATABASE_URL)
--
-- The role cannot create objects, cannot delete leads, and cannot modify audit tables; the
-- per-role timeouts below apply even when a connection pooler hides session settings.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    CREATE ROLE leadgen_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$roles$;

ALTER ROLE leadgen_app PASSWORD :'app_password';
ALTER ROLE leadgen_app SET statement_timeout = '5s';
ALTER ROLE leadgen_app SET lock_timeout = '3s';
ALTER ROLE leadgen_app SET idle_in_transaction_session_timeout = '10s';
