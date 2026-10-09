-- Up Migration
-- =====================================================================================================
-- 0015_crm_read_views — a READ-ONLY contract for the cross-trade CRM (decision D68).
--
-- The CRM is a separate project that shows every trade's leads and businesses in one place. It connects to this database as the
-- role `leadgen_crm` (created by db/roles-crm.sql), which can read the views below and NOTHING else: no table, no write, no function
-- that moves money. The views are the contract; the tables behind them can change as long as a new migration keeps the columns.
--
--   crm.trade_v1            one row: which trade this database is (the CRM refuses a connection whose slug is not the one it expects)
--   crm.leads_v1            one row per real lead: reference, service, OUTWARD postcode, urgency, status, "needs a person"
--   crm.assignments_v1      which business holds or held which lead, at what price, and how it went
--   crm.clients_v1          the businesses (and their wallet balance)
--   crm.client_services_v1  what each business takes
--   crm.charges_v1          what each lead cost the business (reversed charges included, with their status)
--   crm.disputes_v1         disputes as codes only
--   crm.outcomes_v1         what the business reported after calling (codes and job value only)
--
-- Privacy: nothing here reads lead_contacts, a lead's free-text details, its full postcode, IPs, or any note a business or a person typed.
-- A consumer's details stay in this trade's own admin, where every reveal is audited; the CRM links there. Test and deleted leads are left out
-- (the inbox leaves them out too).
--
-- "Needs a person" repeats src/lib/db/lead-predicates.ts `needsAPerson`. tests/integration/crm-read-views.test.ts checks the two agree
-- on every lead of a generated world: change both together (a changed predicate means a NEW migration that replaces this view).
--
-- Roll-forward only.
-- =====================================================================================================

CREATE SCHEMA crm;
COMMENT ON SCHEMA crm IS 'Read-only views for the cross-trade CRM (D68). Never put consumer contact details here.';

CREATE VIEW crm.trade_v1 AS
SELECT v.slug AS slug, v.name AS name, 1 AS contract_version
FROM verticals v
WHERE v.active
ORDER BY v.id
LIMIT 1;

CREATE VIEW crm.leads_v1 AS
SELECT
  l.id,
  l.reference,
  l.created_at,
  l.status::text            AS status,
  l.status_changed_at,
  st.slug                   AS service_slug,
  st.label                  AS service_label,
  l.postcode_outward,
  l.urgency::text           AS urgency,
  l.fraud_decision::text    AS fraud_decision,
  l.assignments_count,
  (l.erased_at IS NOT NULL) AS erased,
  (
    l.status = 'held'
    OR (l.status IN ('new', 'unroutable')
        AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.type = 'lead.handled'))
    OR (l.status = 'assigned'
        AND EXISTS (SELECT 1 FROM lead_assignments a WHERE a.lead_id = l.id AND a.status = 'reserved'))
  )                         AS needs_person
FROM leads l
JOIN service_types st ON st.id = l.service_type_id
WHERE l.deleted_at IS NULL AND NOT l.is_test;

CREATE VIEW crm.assignments_v1 AS
SELECT
  a.id,
  a.lead_id,
  a.client_id,
  a.status::text    AS status,
  a.sale_type::text AS sale_type,
  a.price_pence,
  a.reserved_at,
  a.notified_at,
  a.accepted_at,
  a.rejected_at,
  a.updated_at
FROM lead_assignments a
JOIN leads l ON l.id = a.lead_id
WHERE l.deleted_at IS NULL AND NOT l.is_test;

CREATE VIEW crm.clients_v1 AS
SELECT
  c.id,
  c.name,
  c.status::text        AS status,
  c.billing_mode::text  AS billing_mode,
  c.delivery_mode::text AS delivery_mode,
  w.balance_pence,
  c.created_at,
  c.updated_at
FROM clients c
LEFT JOIN client_wallets w ON w.client_id = c.id
WHERE c.deleted_at IS NULL;

CREATE VIEW crm.client_services_v1 AS
SELECT cs.client_id, st.slug AS service_slug, st.label AS service_label
FROM client_services cs
JOIN service_types st ON st.id = cs.service_type_id;

CREATE VIEW crm.charges_v1 AS
SELECT ch.id, ch.client_id, ch.assignment_id, ch.amount_pence, ch.status::text AS status, ch.created_at, ch.reversed_at
FROM lead_charges ch;

CREATE VIEW crm.disputes_v1 AS
SELECT d.id, d.client_id, d.assignment_id, d.status::text AS status, d.reason::text AS reason,
       d.resolution::text AS resolution, d.created_at, d.decided_at
FROM disputes d;

CREATE VIEW crm.outcomes_v1 AS
SELECT o.id, o.assignment_id, a.client_id, o.outcome::text AS outcome, o.job_value_pence, o.occurred_at
FROM assignment_contact_attempts o
JOIN lead_assignments a ON a.id = o.assignment_id;

-- The CRM role reads the views and nothing else. Skipped where the role does not exist yet; db/roles-crm.sql repeats these grants,
-- so either order (role first or migration first) ends in the same place.
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_crm') THEN
    GRANT USAGE ON SCHEMA crm TO leadgen_crm;
    GRANT SELECT ON ALL TABLES IN SCHEMA crm TO leadgen_crm;
  END IF;
END
$grants$;
