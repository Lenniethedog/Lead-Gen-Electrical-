-- Up Migration
-- =====================================================================================================
-- 0009_credit_and_charges — Stage 6, slice 3: what a lead costs, and money that can never go wrong silently.
--
--   clients.billing_mode   `invoice` (the default: nothing moves here, staff invoice from the recorded charges) or `prepaid`
--                          (each lead is paid for from the business's credit when it is assigned)
--   client_wallets         one balance per business; the DATABASE forbids it going below zero (docs/00 D50)
--   credit_ledger          append-only log of every movement, each with the balance after it and a unique idempotency key
--   lead_charges           EXACTLY ONE per assignment (UNIQUE), written by a trigger in the assignment's own transaction
--   triggers               charge when an assignment is created; reverse (refund) when it ends without being kept
--   post_credit()          the ONLY way staff add or remove credit: audited, idempotent, refuses to overdraw
--   v_money_problems       reconciliation: wallet vs ledger vs charges. Must always be empty.
--
-- The application role can READ these tables and call post_credit(); it cannot insert, update or delete a wallet, a ledger entry or a
-- charge. All money movement happens in SECURITY DEFINER functions below. Stage 7 (payments) adds `top_up` from a payment provider;
-- the dispute link on the ledger arrives with disputes (slice 4). Roll-forward only.
-- =====================================================================================================

CREATE TYPE billing_mode      AS ENUM ('invoice', 'prepaid');
CREATE TYPE ledger_entry_type AS ENUM ('top_up', 'grant', 'lead_charge', 'refund', 'adjustment', 'expiry');
CREATE TYPE charge_source     AS ENUM ('included_allowance', 'credit_balance', 'invoice');
CREATE TYPE charge_status     AS ENUM ('posted', 'reversed');

ALTER TABLE clients ADD COLUMN billing_mode billing_mode NOT NULL DEFAULT 'invoice';

CREATE TABLE client_wallets (
  client_id     uuid PRIMARY KEY REFERENCES clients (id),
  -- The database itself forbids overdrawing: any statement that would make this negative fails with this constraint's name.
  balance_pence bigint NOT NULL DEFAULT 0 CONSTRAINT client_wallets_balance_chk CHECK (balance_pence >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  client_id           uuid NOT NULL REFERENCES clients (id),
  entry_type          ledger_entry_type NOT NULL,
  amount_pence        bigint NOT NULL CHECK (amount_pence <> 0),
  balance_after_pence bigint NOT NULL CHECK (balance_after_pence >= 0),
  assignment_id       uuid REFERENCES lead_assignments (id),
  -- Posting the same business event twice (a retry, a replay) is a no-op: this is what makes "charged twice" unrepresentable.
  idempotency_key     text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  -- A code from a closed list (never free text: it would let a person's details into the money log).
  reason              text CHECK (reason ~ '^[a-z_]{1,40}$'),
  created_by          uuid REFERENCES operators (id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_ledger_sign_chk CHECK (
    (entry_type IN ('top_up', 'grant', 'refund') AND amount_pence > 0) OR
    (entry_type IN ('lead_charge', 'expiry') AND amount_pence < 0) OR
    entry_type = 'adjustment'
  ),
  CONSTRAINT credit_ledger_charge_has_assignment_chk CHECK (entry_type NOT IN ('lead_charge', 'refund') OR assignment_id IS NOT NULL)
);
CREATE INDEX credit_ledger_client_idx ON credit_ledger (client_id, id DESC);
CREATE INDEX credit_ledger_assignment_idx ON credit_ledger (assignment_id) WHERE assignment_id IS NOT NULL;
CREATE TRIGGER credit_ledger_append_only BEFORE UPDATE OR DELETE ON credit_ledger FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TABLE lead_charges (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Exactly one charge per assignment: the database makes "charged twice" unrepresentable.
  assignment_id            uuid NOT NULL UNIQUE REFERENCES lead_assignments (id),
  client_id                uuid NOT NULL REFERENCES clients (id),
  amount_pence             integer NOT NULL CHECK (amount_pence >= 0),
  source                   charge_source NOT NULL,
  status                   charge_status NOT NULL DEFAULT 'posted',
  ledger_entry_id          bigint REFERENCES credit_ledger (id),
  reversal_ledger_entry_id bigint REFERENCES credit_ledger (id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  reversed_at              timestamptz,
  CONSTRAINT lead_charges_source_ref_chk CHECK (
    (source = 'credit_balance' AND ledger_entry_id IS NOT NULL) OR
    (source = 'invoice' AND ledger_entry_id IS NULL) OR
    source = 'included_allowance'
  ),
  CONSTRAINT lead_charges_reversed_chk CHECK ((status = 'reversed') = (reversed_at IS NOT NULL)),
  CONSTRAINT lead_charges_reversal_ref_chk CHECK ((status = 'reversed' AND source = 'credit_balance') = (reversal_ledger_entry_id IS NOT NULL))
);
CREATE INDEX lead_charges_client_idx ON lead_charges (client_id, created_at DESC);

-- A charge is never edited except to be reversed, once, and never deleted.
CREATE FUNCTION guard_lead_charge_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a charge cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'posted' OR NEW.status <> 'reversed'
     OR NEW.assignment_id <> OLD.assignment_id OR NEW.client_id <> OLD.client_id OR NEW.amount_pence <> OLD.amount_pence
     OR NEW.source <> OLD.source OR NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a charge can only be reversed, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER lead_charges_guard BEFORE UPDATE OR DELETE ON lead_charges FOR EACH ROW EXECUTE FUNCTION guard_lead_charge_change();

-- ---------------------------------------------------------------------------------------------------
-- Charging: when an assignment is created, in its own transaction.
-- Lock order (docs/AGENTS): lead, assignment, notification, WALLET LAST. This function takes the wallet row lock, and nothing else after it.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION charge_new_assignment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_mode    billing_mode;
  v_balance bigint;
  v_entry   bigint;
BEGIN
  SELECT billing_mode INTO v_mode FROM clients WHERE id = NEW.client_id;
  IF v_mode = 'prepaid' AND NEW.price_pence > 0 THEN
    INSERT INTO client_wallets (client_id) VALUES (NEW.client_id) ON CONFLICT (client_id) DO NOTHING;
    -- One statement both checks and takes the money: concurrent charges queue on this row, and the CHECK refuses an overdraw
    -- (SQLSTATE 23514, constraint client_wallets_balance_chk), which aborts the assignment: no credit, no lead.
    UPDATE client_wallets SET balance_pence = balance_pence - NEW.price_pence, updated_at = now()
     WHERE client_id = NEW.client_id RETURNING balance_pence INTO v_balance;
    INSERT INTO credit_ledger (client_id, entry_type, amount_pence, balance_after_pence, assignment_id, idempotency_key, reason)
    VALUES (NEW.client_id, 'lead_charge', -NEW.price_pence, v_balance, NEW.id, 'charge:' || NEW.id, 'lead_assigned')
    RETURNING id INTO v_entry;
    INSERT INTO lead_charges (assignment_id, client_id, amount_pence, source, ledger_entry_id)
    VALUES (NEW.id, NEW.client_id, NEW.price_pence, 'credit_balance', v_entry);
  ELSE
    -- Invoiced (or free): nothing moves here; the charge is recorded so staff can invoice from it.
    INSERT INTO lead_charges (assignment_id, client_id, amount_pence, source) VALUES (NEW.id, NEW.client_id, NEW.price_pence, 'invoice');
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER lead_assignments_charge AFTER INSERT ON lead_assignments FOR EACH ROW EXECUTE FUNCTION charge_new_assignment();

-- ---------------------------------------------------------------------------------------------------
-- Reversing: when an assignment ends without the business keeping it (taken back, declined, expired, not delivered, refunded).
-- A refund is a NEW ledger entry; nothing is ever edited. Idempotent: it acts only on a charge that is still `posted`.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION reverse_assignment_charge() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c         lead_charges%ROWTYPE;
  v_balance bigint;
  v_entry   bigint;
BEGIN
  SELECT * INTO c FROM lead_charges WHERE assignment_id = NEW.id AND status = 'posted' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF c.source = 'credit_balance' THEN
    UPDATE client_wallets SET balance_pence = balance_pence + c.amount_pence, updated_at = now()
     WHERE client_id = c.client_id RETURNING balance_pence INTO v_balance;
    INSERT INTO credit_ledger (client_id, entry_type, amount_pence, balance_after_pence, assignment_id, idempotency_key, reason)
    VALUES (c.client_id, 'refund', c.amount_pence, v_balance, NEW.id, 'reverse:' || NEW.id, 'lead_not_kept')
    RETURNING id INTO v_entry;
    UPDATE lead_charges SET status = 'reversed', reversed_at = now(), reversal_ledger_entry_id = v_entry WHERE id = c.id;
  ELSE
    UPDATE lead_charges SET status = 'reversed', reversed_at = now() WHERE id = c.id;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER lead_assignments_reverse_charge AFTER UPDATE OF status ON lead_assignments
  FOR EACH ROW WHEN (NEW.status IN ('cancelled', 'rejected', 'expired', 'delivery_failed', 'refunded') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION reverse_assignment_charge();

-- ---------------------------------------------------------------------------------------------------
-- Staff adding or removing credit: the ONLY door. Idempotent on the key, refuses to overdraw, takes the wallet lock last.
-- Returns the ledger entry id (the existing one if the key was already used).
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION post_credit(p_client uuid, p_type ledger_entry_type, p_amount bigint, p_reason text, p_operator uuid, p_key text)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing bigint;
  v_balance  bigint;
  v_entry    bigint;
BEGIN
  IF p_type NOT IN ('top_up', 'grant', 'adjustment') THEN
    RAISE EXCEPTION 'post_credit cannot post a % entry', p_type USING ERRCODE = 'check_violation';
  END IF;
  IF p_operator IS NULL THEN
    RAISE EXCEPTION 'credit must be posted by a named person' USING ERRCODE = 'check_violation';
  END IF;
  SELECT id INTO v_existing FROM credit_ledger WHERE idempotency_key = p_key;
  IF FOUND THEN
    RETURN v_existing;
  END IF;
  INSERT INTO client_wallets (client_id) VALUES (p_client) ON CONFLICT (client_id) DO NOTHING;
  UPDATE client_wallets SET balance_pence = balance_pence + p_amount, updated_at = now()
   WHERE client_id = p_client RETURNING balance_pence INTO v_balance;
  INSERT INTO credit_ledger (client_id, entry_type, amount_pence, balance_after_pence, idempotency_key, reason, created_by)
  VALUES (p_client, p_type, p_amount, v_balance, p_key, p_reason, p_operator)
  RETURNING id INTO v_entry;
  RETURN v_entry;
EXCEPTION WHEN unique_violation THEN
  -- Two requests with the same key at the same instant: the loser returns the winner's entry.
  SELECT id INTO v_existing FROM credit_ledger WHERE idempotency_key = p_key;
  IF FOUND THEN RETURN v_existing; END IF;
  RAISE;
END
$$;

-- ---------------------------------------------------------------------------------------------------
-- Reconciliation: anything this view returns is a bug. Wallet = sum of its ledger = the last balance_after; every posted prepaid charge
-- has its ledger entry (right amount, right sign); every reversed one has its refund; and the other way round.
-- ---------------------------------------------------------------------------------------------------
CREATE VIEW v_money_problems AS
  SELECT w.client_id, 'wallet_differs_from_ledger_sum'::text AS problem
    FROM client_wallets w
   WHERE w.balance_pence <> coalesce((SELECT sum(l.amount_pence) FROM credit_ledger l WHERE l.client_id = w.client_id), 0)
  UNION ALL
  SELECT w.client_id, 'wallet_differs_from_last_balance_after'
    FROM client_wallets w
   WHERE w.balance_pence <> coalesce((SELECT l.balance_after_pence FROM credit_ledger l WHERE l.client_id = w.client_id ORDER BY l.id DESC LIMIT 1), 0)
  UNION ALL
  SELECT l.client_id, 'ledger_without_wallet'
    FROM credit_ledger l WHERE NOT EXISTS (SELECT 1 FROM client_wallets w WHERE w.client_id = l.client_id) GROUP BY l.client_id
  UNION ALL
  SELECT c.client_id, 'prepaid_charge_without_matching_ledger_entry'
    FROM lead_charges c LEFT JOIN credit_ledger l ON l.id = c.ledger_entry_id
   WHERE c.source = 'credit_balance' AND (l.id IS NULL OR l.amount_pence <> -c.amount_pence OR l.entry_type <> 'lead_charge' OR l.assignment_id <> c.assignment_id)
  UNION ALL
  SELECT c.client_id, 'reversed_charge_without_matching_refund'
    FROM lead_charges c LEFT JOIN credit_ledger l ON l.id = c.reversal_ledger_entry_id
   WHERE c.source = 'credit_balance' AND c.status = 'reversed' AND (l.id IS NULL OR l.amount_pence <> c.amount_pence OR l.entry_type <> 'refund')
  UNION ALL
  SELECT l.client_id, 'charge_entry_without_charge'
    FROM credit_ledger l WHERE l.entry_type = 'lead_charge' AND NOT EXISTS (SELECT 1 FROM lead_charges c WHERE c.ledger_entry_id = l.id)
  UNION ALL
  SELECT c.client_id, 'charge_differs_from_assignment_price'
    FROM lead_charges c JOIN lead_assignments a ON a.id = c.assignment_id WHERE a.price_pence <> c.amount_pence
  UNION ALL
  SELECT a.client_id, 'live_assignment_without_posted_charge'
    FROM lead_assignments a
   WHERE a.status IN ('reserved', 'notified', 'accepted', 'disputed') AND NOT EXISTS (SELECT 1 FROM lead_charges c WHERE c.assignment_id = a.id AND c.status = 'posted')
  UNION ALL
  SELECT a.client_id, 'ended_assignment_with_posted_charge'
    FROM lead_assignments a
   WHERE a.status IN ('cancelled', 'rejected', 'expired', 'delivery_failed', 'refunded') AND EXISTS (SELECT 1 FROM lead_charges c WHERE c.assignment_id = a.id AND c.status = 'posted');

-- A business reads only its own money.
ALTER TABLE client_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_ledger  ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_charges   ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_wallets_tenant ON client_wallets FOR SELECT USING (app_client_id() IS NULL OR client_id = app_client_id());
CREATE POLICY credit_ledger_tenant  ON credit_ledger  FOR SELECT USING (app_client_id() IS NULL OR client_id = app_client_id());
CREATE POLICY lead_charges_tenant   ON lead_charges   FOR SELECT USING (app_client_id() IS NULL OR client_id = app_client_id());

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    -- READ ONLY. Every write to these goes through the SECURITY DEFINER functions above.
    GRANT SELECT ON client_wallets, credit_ledger, lead_charges, v_money_problems TO leadgen_app;
    GRANT EXECUTE ON FUNCTION post_credit(uuid, ledger_entry_type, bigint, text, uuid, text) TO leadgen_app;
    REVOKE EXECUTE ON FUNCTION charge_new_assignment(), reverse_assignment_charge(), guard_lead_charge_change() FROM PUBLIC;
  END IF;
  -- Functions are executable by PUBLIC by default; post_credit is the only one anyone should call directly.
  REVOKE EXECUTE ON FUNCTION post_credit(uuid, ledger_entry_type, bigint, text, uuid, text) FROM PUBLIC;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT EXECUTE ON FUNCTION post_credit(uuid, ledger_entry_type, bigint, text, uuid, text) TO leadgen_app;
  END IF;
END
$grants$;
