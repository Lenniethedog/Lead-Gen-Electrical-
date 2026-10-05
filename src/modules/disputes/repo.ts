import { sql } from "kysely";
import type { DisputeReason, DisputeResolution, DisputeStatus } from "@/config/disputes";
import { DISPUTE_WINDOW_DAYS } from "@/config/disputes";
import type { Database } from "@/lib/db/client";

/** All SQL for disputes. The service owns transaction boundaries and the lock order (lead, assignment, dispute; the wallet is last, in a trigger). */

export interface DisputeRow {
  id: string;
  assignmentId: string;
  reference: string;
  clientId: string;
  clientName: string;
  reason: DisputeReason;
  description: string | null;
  status: DisputeStatus;
  resolution: DisputeResolution | null;
  decisionReason: string | null;
  raisedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  chargePence: number;
}

type Raw = {
  id: string; assignment_id: string; reference: string; client_id: string; client_name: string; reason: DisputeReason; description: string | null; status: DisputeStatus;
  resolution: DisputeResolution | null; decision_reason: string | null; raised_by: string; decided_by: string | null; decided_at: Date | null; created_at: Date; price_pence: number;
};
const toRow = (r: Raw, staff: boolean, raisedByName: string | null, decidedByEmail: string | null): DisputeRow => ({
  id: r.id, assignmentId: r.assignment_id, reference: r.reference, clientId: r.client_id, clientName: r.client_name, reason: r.reason, description: r.description, status: r.status,
  resolution: r.resolution, decisionReason: r.decision_reason, raisedBy: staff ? (raisedByName ?? "") : (raisedByName ?? ""), decidedBy: decidedByEmail, decidedAt: r.decided_at, createdAt: r.created_at, chargePence: r.price_pence,
});

const SELECT = sql`
  select d.id, d.assignment_id, l.reference, d.client_id, c.name as client_name, d.reason, d.description, d.status, d.resolution, d.decision_reason,
         d.raised_by, d.decided_by, d.decided_at, d.created_at, a.price_pence, u.name as raised_by_name, o.email as decided_by_email
    from disputes d
    join lead_assignments a on a.id = d.assignment_id
    join leads l on l.id = a.lead_id
    join clients c on c.id = d.client_id
    left join client_users u on u.id = d.raised_by
    left join operators o on o.id = d.decided_by`;

async function run(db: Database, where: ReturnType<typeof sql>, order: ReturnType<typeof sql>, limit: number, staff: boolean): Promise<DisputeRow[]> {
  const { rows } = await sql<Raw & { raised_by_name: string | null; decided_by_email: string | null }>`${SELECT} ${where} ${order} limit ${limit}`.execute(db);
  return rows.map((r) => toRow(r, staff, r.raised_by_name, staff ? r.decided_by_email : null));
}

/** A business's own disputes (decided-by is never shown to the business). */
export function listForBusiness(db: Database, clientId: string, limit: number): Promise<DisputeRow[]> {
  return run(db, sql`where d.client_id = ${clientId}`, sql`order by d.created_at desc, d.id desc`, limit, false);
}

export function listForAssignment(db: Database, clientId: string, assignmentId: string): Promise<DisputeRow[]> {
  return run(db, sql`where d.client_id = ${clientId} and d.assignment_id = ${assignmentId}`, sql`order by d.created_at desc`, 20, false);
}

/** Staff: open ones first (oldest first, they are waiting), then recently decided. */
export async function queue(db: Database): Promise<{ open: DisputeRow[]; decided: DisputeRow[] }> {
  const [open, decided] = await Promise.all([
    run(db, sql`where d.status in ('open', 'under_review')`, sql`order by d.created_at asc`, 200, true),
    run(db, sql`where d.status in ('upheld', 'rejected', 'withdrawn')`, sql`order by coalesce(d.decided_at, d.updated_at) desc`, 50, true),
  ]);
  return { open, decided };
}

export async function detail(db: Database, disputeId: string): Promise<DisputeRow | undefined> {
  return (await run(db, sql`where d.id = ${disputeId}`, sql``, 1, true))[0];
}

export async function countOpen(db: Database): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*) as n from disputes where status in ('open', 'under_review')`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

/** The assignment a business wants to dispute, with whether it is still inside the window. Plain read: the caller locks afterwards. */
export async function peekAssignment(db: Database, assignmentId: string): Promise<{ leadId: string; clientId: string } | undefined> {
  const { rows } = await sql<{ lead_id: string; client_id: string }>`select lead_id, client_id from lead_assignments where id = ${assignmentId}`.execute(db);
  return rows[0] && { leadId: rows[0].lead_id, clientId: rows[0].client_id };
}

/** Is the assignment still inside the dispute window? The database's clock, measured from when the business was told. */
export async function inWindow(db: Database, assignmentId: string): Promise<boolean> {
  const { rows } = await sql<{ ok: boolean }>`
    select coalesce(notified_at, created_at) > now() - make_interval(days => ${DISPUTE_WINDOW_DAYS}) as ok from lead_assignments where id = ${assignmentId}`.execute(db);
  return rows[0]?.ok ?? false;
}

export async function insertDispute(db: Database, input: { assignmentId: string; clientId: string; reason: DisputeReason; description: string | null; raisedBy: string }): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into disputes (assignment_id, client_id, reason, description, raised_by) values (${input.assignmentId}, ${input.clientId}, ${input.reason}::dispute_reason, ${input.description}, ${input.raisedBy})
    returning id`.execute(db);
  return rows[0]!.id;
}

export interface LockedDispute {
  id: string;
  assignmentId: string;
  clientId: string;
  status: DisputeStatus;
  reason: DisputeReason;
  leadId: string;
}

/** Read without locking, to learn which lead and assignment to lock first. */
export async function peekDispute(db: Database, disputeId: string): Promise<{ assignmentId: string; clientId: string; leadId: string } | undefined> {
  const { rows } = await sql<{ assignment_id: string; client_id: string; lead_id: string }>`
    select d.assignment_id, d.client_id, a.lead_id from disputes d join lead_assignments a on a.id = d.assignment_id where d.id = ${disputeId}`.execute(db);
  return rows[0] && { assignmentId: rows[0].assignment_id, clientId: rows[0].client_id, leadId: rows[0].lead_id };
}

export async function lockDispute(db: Database, disputeId: string): Promise<LockedDispute | undefined> {
  const { rows } = await sql<{ id: string; assignment_id: string; client_id: string; status: DisputeStatus; reason: DisputeReason; lead_id: string }>`
    select d.id, d.assignment_id, d.client_id, d.status, d.reason, a.lead_id from disputes d join lead_assignments a on a.id = d.assignment_id where d.id = ${disputeId} for update of d`.execute(db);
  const r = rows[0];
  return r && { id: r.id, assignmentId: r.assignment_id, clientId: r.client_id, status: r.status, reason: r.reason, leadId: r.lead_id };
}

export async function markWithdrawn(db: Database, disputeId: string): Promise<void> {
  await sql`update disputes set status = 'withdrawn' where id = ${disputeId}`.execute(db);
}

export async function markDecided(db: Database, input: { disputeId: string; status: "upheld" | "rejected"; resolution: DisputeResolution | null; operatorId: string; decisionReason: string }): Promise<void> {
  await sql`update disputes set status = ${input.status}::dispute_status, resolution = ${input.resolution}::dispute_resolution, decided_by = ${input.operatorId}, decided_at = now(), decision_reason = ${input.decisionReason}
            where id = ${input.disputeId}`.execute(db);
}
