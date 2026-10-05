import type { Database } from "@/lib/db/client";
import { moneyProblems } from "./repo";

/** What /api/pipeline can say about money. A code only: the endpoint is public. */
export type BillingProblem = "money_does_not_add_up";

/** Wallets, the ledger and the charges must always agree (v_money_problems is empty). Anything else is a bug that needs a person today. */
export async function getBillingHealth(db: Database): Promise<{ ok: boolean; problems: BillingProblem[] }> {
  const problems = await moneyProblems(db);
  return problems.length === 0 ? { ok: true, problems: [] } : { ok: false, problems: ["money_does_not_add_up"] };
}
