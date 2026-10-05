import { sql } from "kysely";
import type { Database } from "./client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Runs `work` as ONE business (docs/00 D45). The transaction is told which business it acts for, and from then on the database
 * itself (row-level security, migration 0007) returns only that business's rows, even from a query that forgot its `WHERE`.
 * The ONLY way the dashboard may reach the database. `clientId` must come from a verified session, never from the browser.
 */
export async function withClientScope<T>(db: Database, clientId: string, work: (scoped: Database) => Promise<T>): Promise<T> {
  // A bad value must never reach set_config: a non-uuid would make every policy comparison throw, and an empty string would mean "no scope".
  if (!UUID.test(clientId)) throw new Error("withClientScope needs a business id");
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.client_id', ${clientId}, true)`.execute(trx);
    return work(trx);
  });
}
