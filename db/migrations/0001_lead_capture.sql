-- Up Migration
-- =====================================================================================================
-- 0001_lead_capture — Stage 1 schema: capture, screen and durably store a consumer enquiry.
--
-- Design rules applied throughout (see docs/02-data-model.md):
--   * Money is never stored here yet; when it is, it is integer pence.
--   * Externally visible entities (leads) use uuid primary keys (non-enumerable, IDOR-resistant);
--     append-only logs use bigint identity keys (cheap, ordered).
--   * Everything personal about the consumer lives in lead_contacts (+ ip/user_agent on
--     consent_records) so erasure/retention is a single, well-defined operation.
--   * Integrity is enforced by the database in addition to application validation: CHECK
--     constraints, FKs, partial unique indexes, a lifecycle transition table, and triggers.
--   * Roll-forward only: there is no down migration. Fix mistakes with a new migration.
-- =====================================================================================================

-- ---------------------------------------------------------------------------------------------------
-- Enumerations (closed sets; adding a value is ALTER TYPE ... ADD VALUE in a later migration)
-- ---------------------------------------------------------------------------------------------------
CREATE TYPE lead_status AS ENUM (
  'new',            -- accepted and screened; waiting to be routed
  'held',           -- fraud score in the review band; waiting for a human decision
  'routing',        -- claimed by the router (transient)
  'assigned',       -- has at least one active assignment
  'unroutable',     -- router found no eligible client
  'duplicate',      -- same enquiry already received (terminal, links to the original)
  'rejected_fraud', -- screened out as spam/fraud (terminal)
  'invalid',        -- found to be unusable after acceptance (terminal)
  'expired'         -- not placed within its freshness window (terminal)
);
CREATE TYPE fraud_decision AS ENUM ('accept', 'flag', 'review', 'reject');
CREATE TYPE property_type AS ENUM ('house', 'bungalow', 'flat', 'commercial');
CREATE TYPE ownership_type AS ENUM ('owner', 'landlord', 'tenant');
CREATE TYPE urgency_level AS ENUM ('emergency', 'within_2_weeks', 'within_1_month', 'just_planning');
CREATE TYPE actor_type AS ENUM ('system', 'consumer', 'client_user', 'staff_user', 'integration');
CREATE TYPE consent_event_type AS ENUM ('granted', 'withdrawn');
CREATE TYPE recipient_model AS ENUM ('first_party', 'shared_one', 'shared_multiple');
CREATE TYPE lead_source_kind AS ENUM (
  'paid_search', 'paid_social', 'organic', 'direct', 'referral', 'partner', 'unknown'
);

-- ---------------------------------------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

-- Guard for append-only tables: audit evidence can never be edited or deleted through SQL DML.
CREATE FUNCTION forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'check_violation';
END
$$;

-- ---------------------------------------------------------------------------------------------------
-- Reference data: verticals, services, sources, geography
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE verticals (
  id                    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  name                  text NOT NULL,
  active                boolean NOT NULL DEFAULT true,
  -- A repeat enquiry for the same job within this window is treated as a duplicate.
  duplicate_window_days smallint NOT NULL DEFAULT 14 CHECK (duplicate_window_days BETWEEN 0 AND 365),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER verticals_set_updated_at BEFORE UPDATE ON verticals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_types (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vertical_id integer NOT NULL REFERENCES verticals (id) ON DELETE RESTRICT,
  slug        text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  label       text NOT NULL,
  sort_order  smallint NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vertical_id, slug)
);
CREATE TRIGGER service_types_set_updated_at BEFORE UPDATE ON service_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE lead_sources (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  name       text NOT NULL,
  kind       lead_source_kind NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Postcode directory (ONS Postcode Directory, loaded by scripts/import-onspd.ts). Rows are never
-- deleted: terminated postcodes stay (terminated_on set) so historic leads keep a valid FK.
CREATE TABLE postcodes (
  postcode            text PRIMARY KEY
                      CHECK (postcode ~ '^[A-Z]{1,2}[0-9][A-Z0-9]? [0-9][A-Z]{2}$'),
  outward             text GENERATED ALWAYS AS (split_part(postcode, ' ', 1)) STORED NOT NULL,
  sector              text GENERATED ALWAYS AS (
                        split_part(postcode, ' ', 1) || ' ' || left(split_part(postcode, ' ', 2), 1)
                      ) STORED NOT NULL,
  area                text GENERATED ALWAYS AS (substring(split_part(postcode, ' ', 1) from '^[A-Z]+')) STORED NOT NULL,
  lat                 double precision CHECK (lat BETWEEN 49 AND 61),
  lng                 double precision CHECK (lng BETWEEN -9 AND 2.5),
  admin_district_code text,
  region_code         text,
  country_code        text,
  introduced_on       date,
  terminated_on       date,
  source              text NOT NULL DEFAULT 'onspd',
  loaded_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT postcodes_coordinates_chk CHECK ((lat IS NULL) = (lng IS NULL))
);
CREATE INDEX postcodes_outward_idx ON postcodes (outward);
CREATE INDEX postcodes_sector_idx ON postcodes (sector);

-- Named geographies (pure geography, independent of any vertical or client)...
CREATE TABLE service_areas (
  id         integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z][a-z0-9_]*$'),
  name       text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER service_areas_set_updated_at BEFORE UPDATE ON service_areas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE service_area_districts (
  service_area_id integer NOT NULL REFERENCES service_areas (id) ON DELETE CASCADE,
  outward         text NOT NULL CHECK (outward ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'),
  PRIMARY KEY (service_area_id, outward)
);
CREATE INDEX service_area_districts_outward_idx ON service_area_districts (outward);

-- ...and the footprint a vertical is currently accepting enquiries from.
CREATE TABLE vertical_service_areas (
  vertical_id     integer NOT NULL REFERENCES verticals (id) ON DELETE CASCADE,
  service_area_id integer NOT NULL REFERENCES service_areas (id) ON DELETE CASCADE,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vertical_id, service_area_id)
);
CREATE INDEX vertical_service_areas_area_idx ON vertical_service_areas (service_area_id);

-- ---------------------------------------------------------------------------------------------------
-- Consent: immutable, versioned wording + an append-only record of each grant/withdrawal
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE consent_texts (
  id              integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code            text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  version         text NOT NULL CHECK (version ~ '^v[0-9]+$'),
  body            text NOT NULL CHECK (char_length(body) BETWEEN 20 AND 4000),
  body_sha256     text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  recipient_model recipient_model NOT NULL,
  -- Upper bound of businesses this consent allows us to share the enquiry with. The router must
  -- never exceed it (enforced again at assignment time, stage 4).
  max_recipients  smallint NOT NULL CHECK (max_recipients BETWEEN 0 AND 10),
  channels        text[] NOT NULL
                  CHECK (cardinality(channels) > 0 AND channels <@ ARRAY['phone', 'sms', 'whatsapp', 'email']),
  effective_from  timestamptz NOT NULL DEFAULT now(),
  retired_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version),
  CONSTRAINT consent_texts_model_chk CHECK (
    (recipient_model = 'first_party'     AND max_recipients = 0) OR
    (recipient_model = 'shared_one'      AND max_recipients = 1) OR
    (recipient_model = 'shared_multiple' AND max_recipients >= 2)
  )
);

CREATE FUNCTION consent_texts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'consent_texts rows can never be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.code IS DISTINCT FROM OLD.code
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.body_sha256 IS DISTINCT FROM OLD.body_sha256
     OR NEW.recipient_model IS DISTINCT FROM OLD.recipient_model
     OR NEW.max_recipients IS DISTINCT FROM OLD.max_recipients
     OR NEW.channels IS DISTINCT FROM OLD.channels
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'published consent wording is immutable; publish a new version instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER consent_texts_guard BEFORE UPDATE OR DELETE ON consent_texts
  FOR EACH ROW EXECUTE FUNCTION consent_texts_guard();

-- ---------------------------------------------------------------------------------------------------
-- Leads
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE leads (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short human reference quoted to consumers, clients and support. Not a secret, never an
  -- authorisation token.
  reference            text NOT NULL UNIQUE
                       CHECK (reference ~ '^L-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$'),
  -- Client-generated key making submission retries safe: one key => at most one lead.
  idempotency_key      uuid NOT NULL UNIQUE,
  -- sha256 of the canonical validated payload; a replay with the same key but different content
  -- is rejected instead of silently returning the old lead.
  payload_fingerprint  text NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  vertical_id          integer NOT NULL REFERENCES verticals (id),
  service_type_id      integer NOT NULL REFERENCES service_types (id),
  source_id            integer NOT NULL REFERENCES lead_sources (id),
  status               lead_status NOT NULL,
  status_changed_at    timestamptz NOT NULL DEFAULT now(),
  -- Full postcode is personal data: NULL after erasure. The outward code is kept for analytics.
  postcode             text REFERENCES postcodes (postcode),
  postcode_outward     text NOT NULL CHECK (postcode_outward ~ '^[A-Z]{1,2}[0-9][A-Z0-9]?$'),
  property_type        property_type NOT NULL,
  ownership            ownership_type NOT NULL,
  urgency              urgency_level NOT NULL,
  -- Vertical-specific answers (e.g. {"scope": "leak"}), validated per vertical in the application.
  details              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  fraud_score          smallint NOT NULL CHECK (fraud_score BETWEEN 0 AND 100),
  fraud_decision       fraud_decision NOT NULL,
  duplicate_of_lead_id uuid REFERENCES leads (id),
  is_test              boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz,
  erased_at            timestamptz,
  CONSTRAINT leads_duplicate_link_chk CHECK ((status = 'duplicate') = (duplicate_of_lead_id IS NOT NULL)),
  CONSTRAINT leads_not_own_duplicate_chk CHECK (duplicate_of_lead_id IS DISTINCT FROM id)
);

CREATE INDEX leads_created_at_idx   ON leads (created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX leads_status_created_idx ON leads (status, created_at DESC) WHERE deleted_at IS NULL;
-- Hot path for the router/sweeper (stage 2+): leads that still need processing, oldest first.
CREATE INDEX leads_work_queue_idx   ON leads (created_at)
  WHERE status IN ('new', 'held', 'routing', 'unroutable') AND deleted_at IS NULL;
CREATE INDEX leads_service_area_idx ON leads (vertical_id, service_type_id, postcode_outward, created_at DESC);
CREATE INDEX leads_source_created_idx ON leads (source_id, created_at DESC);
CREATE INDEX leads_duplicate_of_idx ON leads (duplicate_of_lead_id) WHERE duplicate_of_lead_id IS NOT NULL;

CREATE TRIGGER leads_set_updated_at BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- All personal data supplied by the consumer. Erasing a person = blanking one row (+ leads.postcode).
CREATE TABLE lead_contacts (
  lead_id          uuid PRIMARY KEY REFERENCES leads (id) ON DELETE CASCADE,
  full_name        text CHECK (char_length(full_name) BETWEEN 1 AND 100),
  phone_e164       text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email            text CHECK (char_length(email) <= 254),
  email_normalised text CHECK (char_length(email_normalised) <= 254 AND email_normalised = lower(email_normalised)),
  notes            text CHECK (char_length(notes) <= 2000),
  ip               inet,
  user_agent       text CHECK (char_length(user_agent) <= 512),
  created_at       timestamptz NOT NULL DEFAULT now(),
  erased_at        timestamptz,
  CONSTRAINT lead_contacts_erased_chk CHECK (
    erased_at IS NULL OR (
      full_name IS NULL AND phone_e164 IS NULL AND email IS NULL AND email_normalised IS NULL
      AND notes IS NULL AND ip IS NULL AND user_agent IS NULL
    )
  ),
  CONSTRAINT lead_contacts_complete_chk CHECK (
    erased_at IS NOT NULL OR (full_name IS NOT NULL AND phone_e164 IS NOT NULL AND email_normalised IS NOT NULL)
  )
);
CREATE INDEX lead_contacts_phone_idx ON lead_contacts (phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX lead_contacts_email_idx ON lead_contacts (email_normalised) WHERE email_normalised IS NOT NULL;
CREATE INDEX lead_contacts_ip_idx    ON lead_contacts (ip, created_at DESC) WHERE ip IS NOT NULL;

CREATE TABLE consent_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- RESTRICT: consent evidence must outlive any attempt to delete the lead row.
  lead_id         uuid NOT NULL REFERENCES leads (id) ON DELETE RESTRICT,
  consent_text_id integer NOT NULL REFERENCES consent_texts (id) ON DELETE RESTRICT,
  event           consent_event_type NOT NULL DEFAULT 'granted',
  method          text NOT NULL DEFAULT 'web_form_checkbox' CHECK (method ~ '^[a-z][a-z0-9_]*$'),
  page_path       text CHECK (char_length(page_path) <= 300),
  ip              inet,
  user_agent      text CHECK (char_length(user_agent) <= 512),
  captured_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_records_lead_idx ON consent_records (lead_id, captured_at);
CREATE INDEX consent_records_text_idx ON consent_records (consent_text_id);

CREATE TABLE lead_attributions (
  lead_id        uuid PRIMARY KEY REFERENCES leads (id) ON DELETE CASCADE,
  utm_source     text CHECK (char_length(utm_source) <= 200),
  utm_medium     text CHECK (char_length(utm_medium) <= 200),
  utm_campaign   text CHECK (char_length(utm_campaign) <= 200),
  utm_term       text CHECK (char_length(utm_term) <= 200),
  utm_content    text CHECK (char_length(utm_content) <= 200),
  gclid          text CHECK (char_length(gclid) <= 500),
  fbclid         text CHECK (char_length(fbclid) <= 500),
  msclkid        text CHECK (char_length(msclkid) <= 500),
  landing_path   text CHECK (char_length(landing_path) <= 300),
  referrer_host  text CHECK (char_length(referrer_host) <= 255),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_attributions_campaign_idx ON lead_attributions (utm_campaign) WHERE utm_campaign IS NOT NULL;
CREATE INDEX lead_attributions_gclid_idx    ON lead_attributions (gclid) WHERE gclid IS NOT NULL;

-- Why a lead scored what it scored: one row per contributing signal (no personal data in detail).
CREATE TABLE lead_fraud_signals (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id    uuid NOT NULL REFERENCES leads (id) ON DELETE RESTRICT,
  code       text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  weight     smallint NOT NULL CHECK (weight BETWEEN 0 AND 100),
  detail     jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_fraud_signals_lead_idx ON lead_fraud_signals (lead_id);
CREATE INDEX lead_fraud_signals_code_idx ON lead_fraud_signals (code, created_at DESC);

-- Business-level event log (what happened, by whom). Never contains personal data.
CREATE TABLE lead_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id    uuid NOT NULL REFERENCES leads (id) ON DELETE RESTRICT,
  type       text NOT NULL CHECK (type ~ '^[a-z]+(\.[a-z_]+)+$'),
  actor_type actor_type NOT NULL DEFAULT 'system',
  actor_id   uuid,
  request_id text CHECK (char_length(request_id) <= 100),
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lead_events_lead_idx ON lead_events (lead_id, id);
CREATE INDEX lead_events_type_idx ON lead_events (type, created_at DESC);

-- ---------------------------------------------------------------------------------------------------
-- Lifecycle: allowed transitions + automatic, tamper-resistant status history
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE lead_status_transitions (
  from_status lead_status NOT NULL,
  to_status   lead_status NOT NULL,
  PRIMARY KEY (from_status, to_status),
  CHECK (from_status <> to_status)
);
INSERT INTO lead_status_transitions (from_status, to_status) VALUES
  ('held', 'new'), ('held', 'rejected_fraud'), ('held', 'invalid'), ('held', 'expired'),
  ('new', 'held'), ('new', 'routing'), ('new', 'assigned'), ('new', 'invalid'), ('new', 'expired'),
  ('routing', 'new'), ('routing', 'assigned'), ('routing', 'unroutable'),
  ('unroutable', 'routing'), ('unroutable', 'assigned'), ('unroutable', 'invalid'), ('unroutable', 'expired'),
  ('assigned', 'new'), ('assigned', 'invalid'),
  -- Human overrides of automated decisions (the application restricts these to staff and requires a reason).
  ('duplicate', 'new'), ('rejected_fraud', 'new'), ('expired', 'new');

CREATE TABLE lead_status_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id     uuid NOT NULL REFERENCES leads (id) ON DELETE RESTRICT,
  from_status lead_status,
  to_status   lead_status NOT NULL,
  actor_type  actor_type NOT NULL,
  actor_id    uuid,
  reason      text CHECK (char_length(reason) <= 500),
  request_id  text CHECK (char_length(request_id) <= 100),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (from_status IS DISTINCT FROM to_status)
);
CREATE INDEX lead_status_history_lead_idx ON lead_status_history (lead_id, id);

CREATE FUNCTION enforce_lead_status_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (
      SELECT 1 FROM lead_status_transitions t
      WHERE t.from_status = OLD.status AND t.to_status = NEW.status
    ) THEN
      RAISE EXCEPTION 'illegal lead status transition: % -> %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', HINT = 'allowed transitions are listed in lead_status_transitions';
    END IF;
    NEW.status_changed_at := now();
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER leads_enforce_status_transition BEFORE UPDATE OF status ON leads
  FOR EACH ROW EXECUTE FUNCTION enforce_lead_status_transition();

-- Records every status change (including the initial one). SECURITY DEFINER so the application
-- role can only create history through this trigger, never write to the table directly. Context
-- comes from transaction-local settings: app.actor_type, app.actor_id, app.reason, app.request_id.
CREATE FUNCTION record_lead_status_history() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_actor_type actor_type := coalesce(nullif(current_setting('app.actor_type', true), ''), 'system')::actor_type;
  v_actor_id   uuid       := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_reason     text       := nullif(current_setting('app.reason', true), '');
  v_request_id text       := nullif(current_setting('app.request_id', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO lead_status_history (lead_id, from_status, to_status, actor_type, actor_id, reason, request_id)
    VALUES (NEW.id, NULL, NEW.status, v_actor_type, v_actor_id, v_reason, v_request_id);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO lead_status_history (lead_id, from_status, to_status, actor_type, actor_id, reason, request_id)
    VALUES (NEW.id, OLD.status, NEW.status, v_actor_type, v_actor_id, v_reason, v_request_id);
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER leads_record_status_history AFTER INSERT OR UPDATE OF status ON leads
  FOR EACH ROW EXECUTE FUNCTION record_lead_status_history();

-- A lead can never be committed without recorded consent and contact details (checked at COMMIT,
-- so the rows can be inserted in any order inside the transaction).
CREATE FUNCTION assert_lead_complete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.lead_id = NEW.id AND c.event = 'granted') THEN
    RAISE EXCEPTION 'lead % was committed without recorded consent', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lead_contacts c WHERE c.lead_id = NEW.id) THEN
    RAISE EXCEPTION 'lead % was committed without contact details', NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER leads_require_consent_and_contact AFTER INSERT ON leads
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION assert_lead_complete();

-- Append-only evidence tables.
CREATE TRIGGER lead_events_append_only BEFORE UPDATE OR DELETE ON lead_events
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER lead_status_history_append_only BEFORE UPDATE OR DELETE ON lead_status_history
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER lead_fraud_signals_append_only BEFORE UPDATE OR DELETE ON lead_fraud_signals
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();
CREATE TRIGGER consent_records_append_only BEFORE UPDATE OR DELETE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------------------------------------------------------------------------------------------------
-- Least privilege: the application role gets only what stage 1 needs. The role is created by the
-- platform operator (db/roles.sql); the grants are skipped, not failed, where it does not exist
-- yet (e.g. a developer laptop connecting as the owner).
-- ---------------------------------------------------------------------------------------------------
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT USAGE ON SCHEMA public TO leadgen_app;
    GRANT SELECT ON
      verticals, service_types, lead_sources, postcodes, service_areas, service_area_districts,
      vertical_service_areas, consent_texts, lead_status_transitions, lead_status_history
      TO leadgen_app;
    GRANT SELECT, INSERT, UPDATE ON leads, lead_contacts TO leadgen_app;
    GRANT SELECT, INSERT ON consent_records, lead_attributions, lead_fraud_signals, lead_events
      TO leadgen_app;
  END IF;
END
$grants$;
