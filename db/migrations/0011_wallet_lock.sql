-- Up Migration
-- =====================================================================================================
-- 0011_wallet_lock — Stage 6, slice 3: let the router lock a business's wallet WITHOUT being able to write it.
--
-- `SELECT ... FOR UPDATE` needs the UPDATE privilege, which the application role deliberately does not have on client_wallets (0009).
-- This function takes the row lock as the owner and returns the balance, so the router can read "can this business pay?" and know nobody
-- can spend it before the transaction ends (docs/00 D52). Lock order: lead, assignment, wallet LAST. Roll-forward only.
-- =====================================================================================================
CREATE FUNCTION lock_wallet_balance(p_client uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT balance_pence FROM client_wallets WHERE client_id = p_client FOR UPDATE), 0)
$$;

REVOKE EXECUTE ON FUNCTION lock_wallet_balance(uuid) FROM PUBLIC;
DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadgen_app') THEN
    GRANT EXECUTE ON FUNCTION lock_wallet_balance(uuid) TO leadgen_app;
  END IF;
END
$grants$;
