-- Creates the READ-ONLY role the cross-trade CRM connects as (decision D68). Run as an administrative user, once per environment, before
-- or after the migrations (a migration grants its crm views to the role when it exists; this script grants them when it creates the role
-- later). Harmless to repeat; it also puts back any setting changed by hand.
--
--   psql "$ADMIN_DATABASE_URL" -v crm_password="$(openssl rand -base64 32)" -f db/roles-crm.sql
--
-- The role can read the views in schema `crm` (migration 0015) and nothing else. Its transactions are read-only by default, its
-- statements are cut off quickly, and it may hold at most a few connections, so the CRM can never slow lead capture down or take its
-- connections. Store the password only in the CRM's settings (TRADE_<SLUG>_DATABASE_URL).
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_crm') THEN
    CREATE ROLE leadgen_crm LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION CONNECTION LIMIT 5;
  END IF;
END
$roles$;

ALTER ROLE leadgen_crm PASSWORD :'crm_password';
-- This file is the whole truth about the role: forget any setting made by hand or by an older version of it.
ALTER ROLE leadgen_crm RESET ALL;
ALTER ROLE leadgen_crm CONNECTION LIMIT 5;
ALTER ROLE leadgen_crm SET default_transaction_read_only = on;
ALTER ROLE leadgen_crm SET statement_timeout = '4s';
ALTER ROLE leadgen_crm SET lock_timeout = '1s';
ALTER ROLE leadgen_crm SET idle_in_transaction_session_timeout = '5s';

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'crm') THEN
    GRANT USAGE ON SCHEMA crm TO leadgen_crm;
    GRANT SELECT ON ALL TABLES IN SCHEMA crm TO leadgen_crm;
  END IF;
END
$grants$;
