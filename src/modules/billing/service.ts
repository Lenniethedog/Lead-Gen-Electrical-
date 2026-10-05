import type { Logger } from "pino";
import { BILLING_MODE_CODES, type BillingMode } from "@/config/billing";
import { withClientScope } from "@/lib/db/client-scope";
import type { Database } from "@/lib/db/client";
import { writeAudit } from "@/modules/audit";
import type { ClientSession } from "@/modules/clientauth";
import type { Operator } from "@/modules/inbox";
import { chargedThisMonth, findEntryByKey, getBillingState, listCharges, listLedger, lockPostingKey, moneyProblems, postCredit, setBillingMode, type ChargeRow, type LedgerRow } from "./repo";
import { parseCreditPosting } from "./schemas";

export interface BillingServiceDeps {
  db: Database;
  logger: Logger;
}

export interface BillingOverview {
  mode: BillingMode;
  balancePence: number;
  ledger: LedgerRow[];
  charges: ChargeRow[];
  thisMonth: { leads: number; totalPence: number };
}

export type BillingFailure = "not_found" | "invalid_input" | "insufficient_credit" | "already_in_state" | "invalid_mode";
export type BillingResult<T = object> = ({ ok: true } & T) | { ok: false; code: BillingFailure; errors?: Record<string, string> };

const RECENT = 40;

/**
 * Money, as staff and the business see it. The database does the moving (charge on assignment, refund on release: triggers; staff credit:
 * `post_credit`); this service only reads, asks the one door to open, and keeps the audit trail. It can never write a wallet, a ledger entry or a
 * charge itself: the application role has no right to.
 */
export function createBillingService(deps: BillingServiceDeps) {
  const { db, logger } = deps;

  async function overview(handle: Database, clientId: string, forStaff: boolean): Promise<BillingOverview | undefined> {
    const state = await getBillingState(handle, clientId);
    if (!state) return undefined;
    const [ledger, charges, thisMonth] = await Promise.all([listLedger(handle, clientId, RECENT, forStaff), listCharges(handle, clientId, RECENT), chargedThisMonth(handle, clientId)]);
    return { mode: state.mode, balancePence: state.balancePence, ledger, charges, thisMonth };
  }

  return {
    /** Staff: one business's money. */
    forStaff(clientId: string): Promise<BillingOverview | undefined> {
      return overview(db, clientId, true);
    },

    /** The business's own money (the caller checks the person's role). Scoped to the session's business. */
    forBusiness(session: ClientSession): Promise<BillingOverview | undefined> {
      return withClientScope(db, session.clientId, (scoped) => overview(scoped, session.clientId, false));
    },

    /**
     * Staff add or remove credit. `postingId` comes from the form that was rendered, so pressing the button twice (or a browser retry)
     * posts ONCE: the second request finds the first's entry and says so. A correction that would take the balance below zero is refused by the
     * database, not here.
     */
    async post(input: { operator: Operator; clientId: string; postingId: string; fields: Record<string, string | undefined>; requestId: string }): Promise<BillingResult<{ replay: boolean; balancePence: number }>> {
      if (!/^[0-9a-f-]{36}$/i.test(input.postingId)) return { ok: false, code: "invalid_input" };
      const parsed = parseCreditPosting(input.fields);
      if (!parsed.ok) return { ok: false, code: "invalid_input", errors: parsed.errors as Record<string, string> };
      const { kind, reason, amountPence } = parsed.value;
      const key = `staff:${input.postingId}`;
      try {
        return await db.transaction().execute(async (trx): Promise<BillingResult<{ replay: boolean; balancePence: number }>> => {
          await lockPostingKey(trx, key);
          const state = await getBillingState(trx, input.clientId);
          if (!state) return { ok: false, code: "not_found" };
          const earlier = await findEntryByKey(trx, key);
          if (earlier !== undefined) return { ok: true, replay: true, balancePence: state.balancePence };
          const entryId = await postCredit(trx, { clientId: input.clientId, kind, amountPence, reason, operatorId: input.operator.id, key });
          await writeAudit(trx, { actorId: input.operator.id, action: "billing.credit_posted", entityType: "client", entityId: input.clientId, reason, after: { kind, amount_pence: amountPence, ledger_entry_id: entryId }, requestId: input.requestId });
          const after = await getBillingState(trx, input.clientId);
          return { ok: true, replay: false, balancePence: after?.balancePence ?? 0 };
        });
      } catch (error) {
        const { code, constraint } = error as { code?: string; constraint?: string };
        if (code === "23514" && constraint === "client_wallets_balance_chk") return { ok: false, code: "insufficient_credit" };
        if (code === "23503") return { ok: false, code: "not_found" };
        throw error;
      }
    },

    /** Staff switch how a business pays. Existing charges keep the way they were made; leads assigned from now on follow the new mode. */
    async setMode(input: { operator: Operator; clientId: string; mode: string; requestId: string }): Promise<BillingResult> {
      const mode = BILLING_MODE_CODES.find((code) => code === input.mode);
      if (!mode) return { ok: false, code: "invalid_mode" };
      return db.transaction().execute(async (trx): Promise<BillingResult> => {
        const state = await getBillingState(trx, input.clientId);
        if (!state) return { ok: false, code: "not_found" };
        if (state.mode === mode) return { ok: false, code: "already_in_state" };
        await setBillingMode(trx, input.clientId, mode);
        await writeAudit(trx, { actorId: input.operator.id, action: "billing.mode_changed", entityType: "client", entityId: input.clientId, before: { billing_mode: state.mode }, after: { billing_mode: mode, balance_pence: state.balancePence }, requestId: input.requestId });
        return { ok: true };
      });
    },

    /** Anything wrong with the money, from the reconciliation view. Must be empty; the worker checks it hourly and /api/pipeline reports it. */
    problems(): Promise<Array<{ clientId: string; problem: string }>> {
      return moneyProblems(db);
    },

    /** The worker's hourly check: logs loudly if the money does not add up. */
    async reconcile(): Promise<number> {
      const problems = await moneyProblems(db);
      if (problems.length > 0) logger.error({ check: "money", problems: problems.length, first: problems.slice(0, 5) }, "the money does not add up: a wallet, a ledger and the charges disagree");
      return problems.length;
    },
  };
}

export type BillingService = ReturnType<typeof createBillingService>;
