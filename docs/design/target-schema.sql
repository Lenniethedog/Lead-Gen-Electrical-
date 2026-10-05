-- =====================================================================================================
-- TARGET SCHEMA (DRAFT) — stages 6-10 of docs/07-roadmap.md
--
-- Applies on top of db/migrations 0001 (stage 1), 0002 (stage 2), 0003 (stage 3), 0005 (stage 4) and 0006 (stage 5), whose slices are already
-- cut out of this file. Staff are the `operators` table from stage 2; `users` below is for CLIENT logins
-- (stage 6). It is NOT a migration: each stage will cut
-- its slice into a numbered migration (reviewing the design against what was learned), then this
-- file shrinks and is finally deleted. Until then tests/integration/target-schema.test.ts applies it
-- to a scratch database on every run, so the design cannot rot, and proves the guarantees that
-- matter most (no double-sale, no over-sharing, no double-charge) under real concurrency.
--
-- Money: integer pence, never floats. Ids: uuid for entities people/clients can reference, bigint
-- identity for high-volume append-only logs. Every "active" definition is written once, in the
-- partial-index predicates below, and mirrored in docs/02-data-model.md.
-- =====================================================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------------------------------
-- user_status and client_user_role: `client_user_status` and `client_user_role` are migration 0007 (stage 6).
CREATE TYPE integration_kind   AS ENUM ('webhook', 'api_key');
CREATE TYPE integration_status AS ENUM ('active', 'failing', 'disabled');
-- ledger_entry_type, charge_source, charge_status, billing_mode are migration 0009 (stage 6, slice 3).
CREATE TYPE payment_kind       AS ENUM ('credit_top_up', 'subscription_invoice', 'manual');
CREATE TYPE payment_status     AS ENUM ('pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'paused', 'cancelled');
CREATE TYPE dispute_reason     AS ENUM ('wrong_number', 'not_homeowner', 'out_of_area', 'duplicate', 'spam', 'not_as_described', 'other');
CREATE TYPE dispute_status     AS ENUM ('open', 'under_review', 'upheld', 'rejected', 'withdrawn');
CREATE TYPE dispute_resolution AS ENUM ('credit_refund', 'replacement_lead', 'no_action');
-- contact_outcome is migration 0008 (stage 6).
CREATE TYPE dsr_kind           AS ENUM ('access', 'erasure', 'rectification', 'restriction', 'objection', 'withdraw_consent');
CREATE TYPE dsr_status         AS ENUM ('received', 'verifying', 'in_progress', 'completed', 'refused');
CREATE TYPE blocklist_kind     AS ENUM ('phone', 'email', 'email_domain', 'ip');
CREATE TYPE ad_platform        AS ENUM ('google_ads', 'meta_ads', 'bing_ads', 'other');

-- ---------------------------------------------------------------------------------------------------
-- Client-login identity (stage 6). Staff are `operators` (stage 2) behind Cloudflare Access, with MFA enforced there.
-- (The auth library, if adopted, owns sessions/accounts/verification tables; `users` is ours to extend.)
-- ---------------------------------------------------------------------------------------------------
-- `users` was folded into `client_users` (migration 0007, decision D44): one email belongs to one business, so a person IS a client user.

-- ---------------------------------------------------------------------------------------------------
-- Clients (the businesses that buy leads)
-- ---------------------------------------------------------------------------------------------------
-- The `clients` table itself is migration 0003; its routing preferences (timezone, priority, weight, daily and monthly caps) are 0005.
-- `max_open_leads` waits for stage 6: "unanswered" cannot be measured until a client can accept or reject a lead.
ALTER TABLE clients
  ADD COLUMN vat_number         text,
  ADD COLUMN billing_email      text,
  ADD COLUMN stripe_customer_id text UNIQUE;

-- client_users, client_login_tokens and client_sessions are migration 0007.

-- client_services is migration 0003; a per-client price override arrives with pricing (stage 6).
ALTER TABLE client_services ADD COLUMN price_override_pence integer CHECK (price_override_pence >= 0);

-- client_working_hours and client_pauses are migration 0005.

-- client_service_areas (coverage rules) and pricing_rules (flat prices) are migration 0003.

-- ---------------------------------------------------------------------------------------------------
-- Pricing and commercial models
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE plans (
  id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                         text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name                         text NOT NULL,
  monthly_fee_pence            integer NOT NULL DEFAULT 0 CHECK (monthly_fee_pence >= 0),
  included_leads               integer NOT NULL DEFAULT 0 CHECK (included_leads >= 0),
  -- Model C: leads beyond the allowance are charged at the normal price less this discount.
  extra_lead_discount_pct      smallint NOT NULL DEFAULT 0 CHECK (extra_lead_discount_pct BETWEEN 0 AND 100),
  includes_exclusive           boolean NOT NULL DEFAULT true,
  active                       boolean NOT NULL DEFAULT true,
  created_at                   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              uuid NOT NULL REFERENCES clients (id),
  plan_id                uuid NOT NULL REFERENCES plans (id),
  status                 subscription_status NOT NULL DEFAULT 'trialing',
  stripe_subscription_id text UNIQUE,
  current_period_start   timestamptz NOT NULL,
  current_period_end     timestamptz NOT NULL,
  cancel_at_period_end   boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start),
  -- A client has at most ONE live subscription.
  EXCLUDE USING gist (client_id WITH =) WHERE (status IN ('trialing', 'active', 'past_due'))
);
CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The included-lead allowance for one billing period, drawn down atomically.
CREATE TABLE subscription_periods (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  period          tstzrange NOT NULL,
  included_leads  integer NOT NULL CHECK (included_leads >= 0),
  leads_used      integer NOT NULL DEFAULT 0 CHECK (leads_used >= 0),
  CONSTRAINT subscription_periods_within_allowance_chk CHECK (leads_used <= included_leads),
  EXCLUDE USING gist (subscription_id WITH =, period WITH &&)
);

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           uuid NOT NULL REFERENCES clients (id),
  provider            text NOT NULL DEFAULT 'stripe',
  provider_payment_id text NOT NULL,
  kind                payment_kind NOT NULL,
  amount_pence        integer NOT NULL CHECK (amount_pence > 0),
  currency            char(3) NOT NULL DEFAULT 'GBP',
  status              payment_status NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)       -- a replayed webhook can never create a second payment
);
CREATE INDEX payments_client_idx ON payments (client_id, created_at DESC);

-- client_wallets, credit_ledger and lead_charges are migration 0009 (stage 6, slice 3): charged by a trigger, refunded by a trigger, written only by
-- SECURITY DEFINER functions. Stage 7 adds payment_id to the ledger and subscription_period_id to charges (included allowance).
-- ---------------------------------------------------------------------------------------------------
-- Routing configuration and audit
-- ---------------------------------------------------------------------------------------------------
-- routing_rules, routing_runs and routing_settings are migration 0005.

-- ---------------------------------------------------------------------------------------------------
-- Assignments: the exclusivity core is migration 0003 (leads.sale_model, lead_assignments, its two unique indexes,
-- the count trigger, lifecycle, history and consent guards). The link to the routing audit (`routing_run_id`) is 0005.
-- ---------------------------------------------------------------------------------------------------

-- assignment_contact_attempts is migration 0008 (stage 6, slice 2); clients.max_open_leads too.

-- ---------------------------------------------------------------------------------------------------
-- Disputes, ledger and charges: money can never go wrong silently
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE disputes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid NOT NULL REFERENCES lead_assignments (id),
  client_id     uuid NOT NULL REFERENCES clients (id),
  reason        dispute_reason NOT NULL,
  description   text CHECK (char_length(description) <= 2000),
  status        dispute_status NOT NULL DEFAULT 'open',
  resolution    dispute_resolution,
  raised_by     uuid REFERENCES client_users (id),
  decided_by    uuid REFERENCES operators (id),
  decided_at    timestamptz,
  decision_note text CHECK (char_length(decision_note) <= 2000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT disputes_decision_chk CHECK ((status IN ('upheld', 'rejected')) = (decided_at IS NOT NULL)),
  CONSTRAINT disputes_upheld_has_resolution_chk CHECK (status <> 'upheld' OR resolution IS NOT NULL)
);
CREATE UNIQUE INDEX disputes_one_open_per_assignment ON disputes (assignment_id) WHERE status IN ('open', 'under_review');
CREATE TRIGGER disputes_set_updated_at BEFORE UPDATE ON disputes FOR EACH ROW EXECUTE FUNCTION set_updated_at();



-- ---------------------------------------------------------------------------------------------------
-- Delivery: the outbox and its attempts (see docs/03-routing-and-delivery.md)
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE client_integrations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                 uuid NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  kind                      integration_kind NOT NULL,
  label                     text NOT NULL,
  endpoint_url              text CHECK (endpoint_url ~ '^https://'),
  signing_secret_ciphertext bytea,                    -- envelope-encrypted; plaintext is never stored
  api_key_prefix            text,
  api_key_sha256            text UNIQUE,              -- shown to the client once; only the hash is kept
  status                    integration_status NOT NULL DEFAULT 'active',
  consecutive_failures      smallint NOT NULL DEFAULT 0,
  last_success_at           timestamptz,
  last_failure_at           timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  revoked_at                timestamptz,
  CONSTRAINT client_integrations_shape_chk CHECK (
    (kind = 'webhook' AND endpoint_url IS NOT NULL AND signing_secret_ciphertext IS NOT NULL) OR
    (kind = 'api_key' AND api_key_sha256 IS NOT NULL)
  )
);
CREATE INDEX client_integrations_client_idx ON client_integrations (client_id) WHERE revoked_at IS NULL;

-- notifications, notification_attempts and provider_events are migration 0006 (stage 5). A business's own webhook address and encrypted secret live on
-- `clients` there; `client_integrations` below is the stage-8 self-service version (several webhooks, client API keys).

-- ---------------------------------------------------------------------------------------------------
-- Acquisition and attribution (see docs/02-data-model.md, "Attribution and ROAS")
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE ad_campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         ad_platform NOT NULL,
  external_id      text NOT NULL,                    -- the platform's campaign id (also our utm_campaign)
  name             text,
  vertical_id      integer REFERENCES verticals (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, external_id)
);

CREATE TABLE ad_spend_daily (
  campaign_id  uuid NOT NULL REFERENCES ad_campaigns (id),
  spend_date   date NOT NULL,
  impressions  integer CHECK (impressions >= 0),
  clicks       integer CHECK (clicks >= 0),
  cost_pence   bigint NOT NULL CHECK (cost_pence >= 0),
  currency     char(3) NOT NULL DEFAULT 'GBP',
  imported_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, spend_date)              -- re-importing a day overwrites it: idempotent
);

-- Click-level data imported from Google Ads (click_view) keyed by gclid: resolves a lead to its
-- keyword and ad group without storing any visitor data ourselves.
CREATE TABLE ad_clicks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform    ad_platform NOT NULL,
  click_id    text NOT NULL,
  campaign_id uuid REFERENCES ad_campaigns (id),
  ad_group    text,
  keyword     text,
  clicked_at  timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (platform, click_id)
);

ALTER TABLE lead_attributions ADD COLUMN campaign_id uuid REFERENCES ad_campaigns (id);
CREATE INDEX lead_attributions_campaign_id_idx ON lead_attributions (campaign_id) WHERE campaign_id IS NOT NULL;

-- Spend -> leads -> valid -> sold -> revenue, per campaign per day. CPL and ROAS are ratios of these.
CREATE VIEW v_campaign_funnel_daily AS
WITH leads_by_day AS (
  SELECT a.campaign_id,
         l.created_at::date AS day,
         count(*)                                                                   AS leads,
         count(*) FILTER (WHERE l.status NOT IN ('duplicate', 'rejected_fraud', 'invalid')) AS valid_leads,
         count(*) FILTER (WHERE l.sale_model IS NOT NULL AND l.assignments_count > 0)       AS sold_leads
  FROM leads l JOIN lead_attributions a ON a.lead_id = l.id
  WHERE a.campaign_id IS NOT NULL AND NOT l.is_test
  GROUP BY 1, 2
), revenue_by_day AS (
  SELECT a.campaign_id, l.created_at::date AS day, sum(c.amount_pence) AS revenue_pence
  FROM lead_charges c
  JOIN lead_assignments la ON la.id = c.assignment_id
  JOIN leads l ON l.id = la.lead_id
  JOIN lead_attributions a ON a.lead_id = l.id
  WHERE c.status = 'posted' AND a.campaign_id IS NOT NULL AND NOT l.is_test
  GROUP BY 1, 2
)
SELECT s.campaign_id, s.spend_date AS day, s.cost_pence AS spend_pence,
       coalesce(d.leads, 0) AS leads, coalesce(d.valid_leads, 0) AS valid_leads, coalesce(d.sold_leads, 0) AS sold_leads,
       coalesce(r.revenue_pence, 0) AS revenue_pence,
       s.cost_pence::numeric / nullif(d.leads, 0)                AS cost_per_lead_pence,
       s.cost_pence::numeric / nullif(d.valid_leads, 0)          AS cost_per_valid_lead_pence,
       s.cost_pence::numeric / nullif(d.sold_leads, 0)           AS cost_per_sold_lead_pence,
       coalesce(r.revenue_pence, 0)::numeric / nullif(s.cost_pence, 0) AS roas
FROM ad_spend_daily s
LEFT JOIN leads_by_day d   ON d.campaign_id = s.campaign_id AND d.day = s.spend_date
LEFT JOIN revenue_by_day r ON r.campaign_id = s.campaign_id AND r.day = s.spend_date;

-- ---------------------------------------------------------------------------------------------------
-- Fraud, privacy operations and administration
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE blocklist_entries (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       blocklist_kind NOT NULL,
  value_sha256 text NOT NULL CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),   -- hashed: the list itself holds no personal data
  reason     text NOT NULL,
  expires_at timestamptz,
  created_by uuid REFERENCES operators (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kind, value_sha256)
);

CREATE TABLE data_subject_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 dsr_kind NOT NULL,
  status               dsr_status NOT NULL DEFAULT 'received',
  lead_id              uuid REFERENCES leads (id),
  requester_email_sha256 text,
  received_at          timestamptz NOT NULL DEFAULT now(),
  due_at               timestamptz NOT NULL,           -- statutory clock: one month from receipt (set by the application)
  completed_at         timestamptz,
  handled_by           uuid REFERENCES operators (id),
  notes                text CHECK (char_length(notes) <= 4000),
  CHECK ((status IN ('completed', 'refused')) = (completed_at IS NOT NULL))
);
CREATE INDEX dsr_open_idx ON data_subject_requests (due_at) WHERE completed_at IS NULL;

-- suppressions and audit_logs are migration 0003.
