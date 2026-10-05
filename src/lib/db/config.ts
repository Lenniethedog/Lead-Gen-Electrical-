import type { PoolConfig } from "pg";

export type DatabaseSsl = "disable" | "require" | "verify-full";

export function parseDatabaseSsl(value: string | undefined): DatabaseSsl {
  if (value === undefined || value === "" || value === "disable") return "disable";
  if (value === "require" || value === "verify-full") return value;
  throw new Error(`DATABASE_SSL must be one of disable | require | verify-full (got "${value}")`);
}

interface PgConnectionInput {
  url: string;
  /** Raw DATABASE_SSL value. */
  ssl?: string | undefined;
  max?: number;
  applicationName?: string;
  /** Client-side guard rails for the web runtime. Leave unset for migrations/long scripts. */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
}

/**
 * Single place that turns configuration into node-postgres settings, shared by the web app,
 * the migration runner, seeds and tests.
 *
 * Note on SSL: we deliberately do not read `sslmode` from the URL. Its semantics differ between
 * libpq and node-postgres versions; one explicit setting avoids silently connecting unencrypted
 * or silently skipping certificate verification.
 *   disable     - no TLS (private network / local development)
 *   require     - TLS, certificate NOT verified (like libpq sslmode=require)
 *   verify-full - TLS with certificate and hostname verification (recommended for public endpoints)
 */
export function pgConnectionConfig(input: PgConnectionInput): PoolConfig {
  const ssl = parseDatabaseSsl(input.ssl);
  return {
    connectionString: input.url,
    ssl: ssl === "disable" ? false : { rejectUnauthorized: ssl === "verify-full" },
    ...(input.max !== undefined && { max: input.max }),
    ...(input.applicationName !== undefined && { application_name: input.applicationName }),
    ...(input.statementTimeoutMs !== undefined && { statement_timeout: input.statementTimeoutMs }),
    ...(input.lockTimeoutMs !== undefined && { lock_timeout: input.lockTimeoutMs }),
    ...(input.idleInTransactionTimeoutMs !== undefined && {
      idle_in_transaction_session_timeout: input.idleInTransactionTimeoutMs,
    }),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  };
}
