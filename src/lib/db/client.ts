import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { getLogger } from "../logger";
import { pgConnectionConfig } from "./config";
import type { DB } from "./schema";

/** A Kysely handle. A `Transaction<DB>` is also a `Kysely<DB>`, so repositories accept either. */
export type Database = Kysely<DB>;

export interface CreateDbOptions {
  url: string;
  ssl?: string | undefined;
  poolMax?: number;
  applicationName?: string;
  /** Guard rails for request-serving connections. Omit for scripts and migrations. */
  timeouts?: { statementMs: number; lockMs: number; idleInTransactionMs: number };
}

/**
 * Framework-agnostic factory (used by the web app, scripts and tests). It deliberately does not
 * import "server-only"; the Next.js-facing accessor lives in src/server/db.ts.
 */
export function createDb(options: CreateDbOptions): Database {
  const pool = new Pool(
    pgConnectionConfig({
      url: options.url,
      ssl: options.ssl,
      ...(options.poolMax !== undefined && { max: options.poolMax }),
      ...(options.applicationName !== undefined && { applicationName: options.applicationName }),
      ...(options.timeouts && {
        statementTimeoutMs: options.timeouts.statementMs,
        lockTimeoutMs: options.timeouts.lockMs,
        idleInTransactionTimeoutMs: options.timeouts.idleInTransactionMs,
      }),
    }),
  );

  // Without a listener, an error on an idle pooled client (database restart, network blip) is an
  // uncaught exception that kills the process.
  pool.on("error", (error) => {
    getLogger().error({ err: error }, "idle postgres client error");
  });
  // The pool only listens to clients that are IDLE. A connection killed while a query or transaction is in flight (a failover, an
  // administrator, an out-of-memory kill) makes `pg` emit `error` on a CHECKED-OUT client too; with no listener that is an uncaught
  // exception and takes the whole process down, instead of failing the one query (which is already rejected with the same error).
  // Found by a test that terminates the router's connection mid-transaction (tests/integration/routing-concurrency.test.ts).
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      getLogger().warn({ err: error }, "postgres connection error while in use");
    });
  });

  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
}
