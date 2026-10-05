import { sql } from "kysely";
import type { Database } from "./client";

/**
 * Transaction-local context read by the database triggers that write lead_status_history and lead_assignment_status_history,
 * and that REFUSE a held-lead decision or a manual end of an assignment that arrives without a person and a reason (migrations
 * 0002 and 0003). Call it first in any transaction that changes those statuses on behalf of a person.
 */
export async function setStaffContext(db: Database, input: { operatorId: string; reason?: string | undefined; requestId: string }): Promise<void> {
  await sql`select set_config('app.actor_type', 'staff_user', true),
                   set_config('app.actor_id', ${input.operatorId}, true),
                   set_config('app.reason', ${input.reason ?? ""}, true),
                   set_config('app.request_id', ${input.requestId}, true)`.execute(db);
}

/** For automated changes (stage 4's router, sweepers). */
export async function setSystemContext(db: Database, input: { requestId: string; reason?: string | undefined }): Promise<void> {
  await sql`select set_config('app.actor_type', 'system', true), set_config('app.actor_id', '', true),
                   set_config('app.reason', ${input.reason ?? ""}, true), set_config('app.request_id', ${input.requestId}, true)`.execute(db);
}
