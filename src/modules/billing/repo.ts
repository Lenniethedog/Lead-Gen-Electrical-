import { sql } from "kysely";
import type { BillingMode, CreditKind, LedgerEntryType } from "@/config/billing";
import type { Database } from "@/lib/db/client";

/** All SQL for money reads and the staff credit door. Writes to wallets, the ledger and charges happen ONLY in database functions (migration 0009). */

export interface LedgerRow {
  id: number;
  type: LedgerEntryType;
  amountPence: number;
  balanceAfterPence: number;
  reason: string | null;
  reference: string | null;
  at: Date;
  by: string | null;
}

export interface ChargeRow {
  id: string;
  reference: string;
  amountPence: number;
  source: "credit_balance" | "invoice" | "included_allowance";
  status: "posted" | "reversed";
  at: Date;
  reversedAt: Date | null;
}

export async function getBillingState(db: Database, clientId: string): Promise<{ mode: BillingMode; balancePence: number; hasWallet: boolean } | undefined> {
  const { rows } = await sql<{ mode: BillingMode; balance: string | null }>`
    select c.billing_mode as mode, w.balance_pence as balance from clients c left join client_wallets w on w.client_id = c.id
     where c.id = ${clientId} and c.deleted_at is null`.execute(db);
  const row = rows[0];
  return row && { mode: row.mode, balancePence: Number(row.balance ?? 0), hasWallet: row.balance !== null };
}

export async function listLedger(db: Database, clientId: string, limit: number, forStaff: boolean): Promise<LedgerRow[]> {
  const { rows } = await sql<{ id: string; entry_type: LedgerEntryType; amount_pence: string; balance_after_pence: string; reason: string | null; reference: string | null; created_at: Date; by: string | null }>`
    select l.id, l.entry_type, l.amount_pence, l.balance_after_pence, l.reason, ld.reference, l.created_at,
           ${forStaff ? sql`o.email` : sql`null::text`} as by
      from credit_ledger l
      left join lead_assignments a on a.id = l.assignment_id
      left join leads ld on ld.id = a.lead_id
      ${forStaff ? sql`left join operators o on o.id = l.created_by` : sql``}
     where l.client_id = ${clientId}
     order by l.id desc limit ${limit}`.execute(db);
  return rows.map((r) => ({ id: Number(r.id), type: r.entry_type, amountPence: Number(r.amount_pence), balanceAfterPence: Number(r.balance_after_pence), reason: r.reason, reference: r.reference, at: r.created_at, by: r.by }));
}

export async function listCharges(db: Database, clientId: string, limit: number): Promise<ChargeRow[]> {
  const { rows } = await sql<{ id: string; reference: string; amount_pence: number; source: ChargeRow["source"]; status: ChargeRow["status"]; created_at: Date; reversed_at: Date | null }>`
    select c.id, ld.reference, c.amount_pence, c.source, c.status, c.created_at, c.reversed_at
      from lead_charges c join lead_assignments a on a.id = c.assignment_id join leads ld on ld.id = a.lead_id
     where c.client_id = ${clientId} order by c.created_at desc, c.id desc limit ${limit}`.execute(db);
  return rows.map((r) => ({ id: r.id, reference: r.reference, amountPence: r.amount_pence, source: r.source, status: r.status, at: r.created_at, reversedAt: r.reversed_at }));
}

/** What the business has been charged this calendar month (its own time zone), net of reversals. */
export async function chargedThisMonth(db: Database, clientId: string): Promise<{ leads: number; totalPence: number }> {
  const { rows } = await sql<{ leads: string; total: string }>`
    select count(*) as leads, coalesce(sum(c.amount_pence), 0) as total
      from lead_charges c join clients cl on cl.id = c.client_id
     where c.client_id = ${clientId} and c.status = 'posted'
       and c.created_at >= (date_trunc('month', now() at time zone cl.timezone) at time zone cl.timezone)`.execute(db);
  return { leads: Number(rows[0]?.leads ?? 0), totalPence: Number(rows[0]?.total ?? 0) };
}

export async function setBillingMode(db: Database, clientId: string, mode: BillingMode): Promise<void> {
  await sql`update clients set billing_mode = ${mode}::billing_mode where id = ${clientId}`.execute(db);
}

/** Serialises requests carrying the same key, so "already posted?" and "post" cannot interleave (the audit entry is then written once). */
export async function lockPostingKey(db: Database, key: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db);
}

export async function findEntryByKey(db: Database, key: string): Promise<number | undefined> {
  const { rows } = await sql<{ id: string }>`select id from credit_ledger where idempotency_key = ${key}`.execute(db);
  return rows[0] ? Number(rows[0].id) : undefined;
}

export async function postCredit(db: Database, input: { clientId: string; kind: CreditKind; amountPence: number; reason: string; operatorId: string; key: string }): Promise<number> {
  const { rows } = await sql<{ id: string }>`select post_credit(${input.clientId}::uuid, ${input.kind}::ledger_entry_type, ${input.amountPence}::bigint, ${input.reason}, ${input.operatorId}::uuid, ${input.key}) as id`.execute(db);
  return Number(rows[0]!.id);
}

export async function moneyProblems(db: Database): Promise<Array<{ clientId: string; problem: string }>> {
  const { rows } = await sql<{ client_id: string; problem: string }>`select client_id, problem from v_money_problems order by client_id, problem`.execute(db);
  return rows.map((r) => ({ clientId: r.client_id, problem: r.problem }));
}
