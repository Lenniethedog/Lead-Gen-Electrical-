-- Up Migration
-- =====================================================================================================
-- 0016_crm_child_view_filters — child CRM views follow the same privacy filter as the parent views.
--
-- 0015 left test and deleted leads out of crm.leads_v1 and crm.assignments_v1, but charges, disputes and
-- outcomes were unfiltered, so a test or deleted lead's money and dispute codes were still readable by
-- the CRM role. These views keep the same columns and add the same predicate: not deleted, not a test.
--
-- Roll-forward only. CREATE OR REPLACE keeps the grants from 0015.
-- =====================================================================================================

-- A WHERE EXISTS (not a join) keeps charges and disputes single-table views, so a write is still
-- refused as a missing privilege (42501) rather than as "this view cannot be updated".
CREATE OR REPLACE VIEW crm.charges_v1 AS
SELECT ch.id, ch.client_id, ch.assignment_id, ch.amount_pence, ch.status::text AS status, ch.created_at, ch.reversed_at
FROM lead_charges ch
WHERE EXISTS (
  SELECT 1 FROM lead_assignments a
  JOIN leads l ON l.id = a.lead_id
  WHERE a.id = ch.assignment_id AND l.deleted_at IS NULL AND NOT l.is_test
);

CREATE OR REPLACE VIEW crm.disputes_v1 AS
SELECT d.id, d.client_id, d.assignment_id, d.status::text AS status, d.reason::text AS reason,
       d.resolution::text AS resolution, d.created_at, d.decided_at
FROM disputes d
WHERE EXISTS (
  SELECT 1 FROM lead_assignments a
  JOIN leads l ON l.id = a.lead_id
  WHERE a.id = d.assignment_id AND l.deleted_at IS NULL AND NOT l.is_test
);

CREATE OR REPLACE VIEW crm.outcomes_v1 AS
SELECT o.id, o.assignment_id, a.client_id, o.outcome::text AS outcome, o.job_value_pence, o.occurred_at
FROM assignment_contact_attempts o
JOIN lead_assignments a ON a.id = o.assignment_id
WHERE EXISTS (
  SELECT 1 FROM leads l
  WHERE l.id = a.lead_id AND l.deleted_at IS NULL AND NOT l.is_test
);
