import "server-only";
import { createDb, type Database } from "@/lib/db/client";
import { getServerEnv } from "@/lib/env";

// Next.js re-evaluates modules on every hot reload in development; keep ONE pool per process
// instead of leaking a new pool (and its connections) on each edit.
const globalForDb = globalThis as typeof globalThis & { __leadgenDb?: Database };

export function getDb(): Database {
  if (!globalForDb.__leadgenDb) {
    const env = getServerEnv();
    globalForDb.__leadgenDb = createDb({
      url: env.DATABASE_URL,
      ssl: env.DATABASE_SSL,
      poolMax: env.DATABASE_POOL_MAX,
      applicationName: "leadgen-web",
      timeouts: { statementMs: 5_000, lockMs: 3_000, idleInTransactionMs: 10_000 },
    });
  }
  return globalForDb.__leadgenDb;
}
