import { sql } from "kysely";
import type { Logger } from "pino";
import type { ConsentDefinition } from "@/config/consent";
import type { Database } from "@/lib/db/client";
import { jsonResponse } from "@/lib/http";
import { verifyConsentArchive } from "@/modules/consent";

/** Liveness: the process is up and serving. Deliberately touches nothing else. */
export function handleHealth(): Response {
  return jsonResponse({ status: "ok" });
}

export interface ReadyDeps {
  db: Database;
  consent: ConsentDefinition;
  logger: Logger;
}

type CheckResult = "ok" | "fail";

async function run(name: string, logger: Logger, check: () => Promise<boolean>): Promise<CheckResult> {
  try {
    return (await check()) ? "ok" : "fail";
  } catch (error) {
    logger.error({ err: error, check: name }, "readiness check threw");
    return "fail";
  }
}

/**
 * Readiness: can this instance do its job? Deploys/health checks should gate traffic on this.
 *   database  - we can query Postgres
 *   postcodes - the ONS postcode directory has been loaded (without it every postcode is "not found")
 *   consent   - the consent wording in code matches the immutable archive (see src/config/consent.ts)
 * Returns check names only, never details, since the endpoint is public.
 */
export async function handleReady(deps: ReadyDeps): Promise<Response> {
  const database = await run("database", deps.logger, async () => {
    await sql`select 1`.execute(deps.db);
    return true;
  });

  const [postcodes, consent] =
    database === "ok"
      ? await Promise.all([
          run("postcodes", deps.logger, async () => {
            const row = await deps.db.selectFrom("postcodes").select("postcode").limit(1).executeTakeFirst();
            return row !== undefined;
          }),
          run("consent", deps.logger, () => verifyConsentArchive(deps.db, deps.consent)),
        ])
      : (["fail", "fail"] as const);

  const checks = { database, postcodes, consent };
  const ready = Object.values(checks).every((value) => value === "ok");
  return jsonResponse({ status: ready ? "ready" : "not_ready", checks }, { status: ready ? 200 : 503 });
}
