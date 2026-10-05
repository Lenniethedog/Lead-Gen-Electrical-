-- Up Migration
-- =====================================================================================================
-- 0010_backfill_lead_charges — Stage 6, slice 3: give every assignment that existed before charging a charge record.
--
-- Before migration 0009 an assignment cost nothing in the system (staff invoiced by hand). So each existing assignment gets an INVOICE
-- charge at its own price: `posted` while the business still holds it, `reversed` once it has ended. No wallet and no ledger entry is
-- touched (nothing was ever paid from credit). From now on the trigger does this for every new assignment, and the reconciliation view
-- (v_money_problems) can be read as "must be empty" from day one. Idempotent. Roll-forward only.
-- =====================================================================================================
INSERT INTO lead_charges (assignment_id, client_id, amount_pence, source, status, reversed_at, created_at)
SELECT a.id, a.client_id, a.price_pence, 'invoice',
       CASE WHEN a.status IN ('reserved', 'notified', 'accepted', 'disputed') THEN 'posted'::charge_status ELSE 'reversed'::charge_status END,
       CASE WHEN a.status IN ('reserved', 'notified', 'accepted', 'disputed') THEN NULL ELSE a.updated_at END,
       a.created_at
  FROM lead_assignments a
 WHERE NOT EXISTS (SELECT 1 FROM lead_charges c WHERE c.assignment_id = a.id);
