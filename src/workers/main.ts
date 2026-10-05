import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { loadEnvConfig } from "@next/env";
import { EnvError, getWorkerEnv, type WorkerEnv } from "@/lib/env";
import { createDb } from "@/lib/db/client";
import { pgConnectionConfig } from "@/lib/db/config";
import { initErrorReporting } from "@/lib/error-reporting";
import { getLogger, setLogService } from "@/lib/logger";
import { createChannelSenders } from "@/integrations/delivery";
import { createEmailSender } from "@/integrations/email";
import { parseSecretsKey } from "@/lib/secrets";
import { NOTIFICATIONS_CHANNEL, createDeliveryService } from "@/modules/delivery";
import { ALERTS_CHANNEL, createAlertService } from "@/modules/alerts";
import { ALERT_POLICY } from "@/config/lead-events";
import { DEV_PRIVACY_HASH_KEY } from "@/config/privacy";
import { ROOFING } from "@/config/verticals/roofing";
import { createPrivacyService } from "@/modules/privacy";
import { ROUTING_CHANNEL, createRoutingService } from "@/modules/routing";
import { createListener } from "./listener";
import { createWorker } from "./worker";

/**
 * The worker process: `npm run worker` (tsx src/workers/main.ts).
 *
 * Same repository, same database, separate process, so a slow provider or a crash can never take
 * the public website down (and vice versa). Several copies may run at once: every operation is safe
 * to repeat and the database arbitrates (docs/03).
 */
async function main() {
  setLogService("leadgen-worker");
  // Platforms inject real environment variables; this only matters on a laptop (.env.local), exactly as `next dev` does.
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production");

  let env: WorkerEnv;
  try {
    env = getWorkerEnv();
  } catch (error) {
    // Refuse to start with bad configuration: a worker that cannot send must not look healthy.
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(1);
  }

  const logger = getLogger();
  const reporter = await initErrorReporting({
    dsn: env.SENTRY_DSN,
    environment: env.APP_ENV,
    service: "leadgen-worker",
    release: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.SOURCE_VERSION,
  });

  const workerId = `${hostname().slice(0, 40)}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const dbOptions = {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMax: env.DATABASE_POOL_MAX,
    applicationName: "leadgen-worker",
    timeouts: { statementMs: 10_000, lockMs: 3_000, idleInTransactionMs: 15_000 },
  };
  const db = createDb(dbOptions);

  const emailSender = createEmailSender(env);
  const alerts = createAlertService({
    db,
    sender: emailSender,
    logger,
    config: {
      recipients: env.OPERATOR_ALERT_EMAILS.length > 0 ? env.OPERATOR_ALERT_EMAILS : devRecipients(env),
      brandName: env.BRAND_NAME,
      adminBaseUrl: env.ADMIN_BASE_URL ?? env.APP_URL,
      leaseSeconds: env.WORKER_LEASE_SECONDS,
      // Comfortably inside the lease, so a hung provider call is abandoned before anyone else may claim the alert.
      sendTimeoutMs: Math.min(8_000, Math.floor((env.WORKER_LEASE_SECONDS * 1000) / 2)),
      reminderAfterMinutes: env.ALERT_REMINDER_MINUTES,
      graceSeconds: env.WORKER_GRACE_SECONDS,
      lookbackHours: ALERT_POLICY.lookbackHours,
      batchSize: 5,
    },
  });

  // The router (stage 4). It only does anything while an owner has switched automatic routing on (a database setting, no deploy).
  const privacy = createPrivacyService({ db, logger, hashKey: env.PRIVACY_HASH_KEY ?? DEV_PRIVACY_HASH_KEY });
  const routing = createRoutingService({ db, logger, verticalSlug: ROOFING.slug, isSuppressed: privacy.isSuppressed });

  // Delivery to businesses (stage 5). Only businesses an operator has put on automatic delivery have anything to send.
  const delivery = createDeliveryService({
    db,
    logger,
    senders: createChannelSenders(env, emailSender),
    config: {
      brandName: env.BRAND_NAME,
      leaseSeconds: env.WORKER_LEASE_SECONDS,
      sendTimeoutMs: Math.min(8_000, Math.floor((env.WORKER_LEASE_SECONDS * 1000) / 2)),
      batchSize: 5,
      secretsKey: env.DELIVERY_SECRETS_KEY ? parseSecretsKey(env.DELIVERY_SECRETS_KEY) : undefined,
    },
  });

  const worker = createWorker({
    db,
    alerts,
    routing,
    delivery,
    logger,
    workerId,
    pollMs: env.WORKER_POLL_MS,
    reconcileMs: env.WORKER_RECONCILE_MS,
    createListener: (onWake) =>
      createListener({
        connection: pgConnectionConfig({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL, applicationName: "leadgen-worker-listen" }),
        channel: ALERTS_CHANNEL,
        onWake,
        logger,
        purpose: "new operator alerts",
      }),
    createRoutingListener: (onWake) =>
      createListener({
        connection: pgConnectionConfig({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL, applicationName: "leadgen-worker-routing-listen" }),
        channel: ROUTING_CHANNEL,
        onWake,
        logger,
        purpose: "leads to route",
      }),
    createDeliveryListener: (onWake) =>
      createListener({
        connection: pgConnectionConfig({ url: env.DATABASE_URL, ssl: env.DATABASE_SSL, applicationName: "leadgen-worker-delivery-listen" }),
        channel: NOTIFICATIONS_CHANNEL,
        onWake,
        logger,
        purpose: "notifications to send",
      }),
  });

  let shuttingDown = false;
  async function shutdown(signal: string, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    try {
      await worker.stop();
      await db.destroy();
      await reporter.flush(2_000);
    } finally {
      process.exit(exitCode);
    }
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // Anything unexpected: say so, report it, and exit so the platform restarts a clean process.
  // (The database holds all state; a restart loses nothing.)
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error }, "uncaught exception");
    void reporter.flush(2_000).finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason instanceof Error ? reason : new Error(String(reason)) }, "unhandled rejection");
    void reporter.flush(2_000).finally(() => process.exit(1));
  });

  await worker.start();
}

/** Development convenience only (the schema forces real recipients in staging/production). */
function devRecipients(env: WorkerEnv): string[] {
  return env.APP_ENV === "development" || env.APP_ENV === "test" ? ["operator@example.test"] : [];
}

main().catch((error: unknown) => {
  console.error("worker failed to start:", error);
  process.exit(1);
});
