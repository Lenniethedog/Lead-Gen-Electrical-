import type { Logger } from "pino";
import type { Database } from "@/lib/db/client";
import { retryDelayMs } from "./backoff";
import { buildAlertMessage } from "./message";
import type { EmailSender, SendResult } from "./ports";
import {
  claimDueAlerts,
  enqueueMissingAlerts,
  enqueueReminders,
  insertAttempt,
  leadNeedsAttention,
  loadAlertContext,
  markCancelled,
  markFailed,
  markSent,
  notifyAlertsDue,
  reclaimExpiredLeases,
  type ClaimedAlert,
} from "./repo";

export interface AlertServiceConfig {
  /** Who receives alerts. Resolved at send time, so changing it needs no migration and no re-enqueue. */
  recipients: readonly string[];
  brandName: string;
  /** Origin of the protected inbox, no trailing slash. */
  adminBaseUrl: string;
  /** How long a worker may hold an alert before the reconciler takes it back. */
  leaseSeconds: number;
  /** Hard ceiling on one provider call. Must be comfortably below leaseSeconds. */
  sendTimeoutMs: number;
  reminderAfterMinutes: number;
  /** A new/held lead with no alert after this long gets one from the reconciler. */
  graceSeconds: number;
  lookbackHours: number;
  /** Alerts claimed per batch, and sent in parallel. */
  batchSize: number;
}

export interface AlertServiceDeps {
  db: Database;
  sender: EmailSender;
  logger: Logger;
  config: AlertServiceConfig;
  /** Injectable for deterministic retry-timing tests. */
  random?: () => number;
}

export interface ProcessSummary {
  claimed: number;
  sent: number;
  retrying: number;
  dead: number;
  cancelled: number;
}

export interface ReconcileSummary {
  requeued: number;
  dead: number;
  /** Alerts the reconciler had to create. Anything above zero in steady state is a defect worth investigating. */
  missingCreated: number;
  remindersCreated: number;
}

export interface AlertService {
  /** Claims one batch of due alerts and sends them. Call repeatedly until it returns `claimed: 0`. */
  processDue(): Promise<ProcessSummary>;
  /** Idempotent safety net; safe to run from several workers at once. */
  reconcile(): Promise<ReconcileSummary>;
}

const EMPTY: ProcessSummary = { claimed: 0, sent: 0, retrying: 0, dead: 0, cancelled: 0 };

type Disposition = keyof Omit<ProcessSummary, "claimed"> | "lost";

/**
 * The key is stable across attempts, so a retry after "the provider accepted it but we never heard" is answered with the
 * original result instead of a second email. ONE exception: if the provider says this key was already used for a DIFFERENT
 * payload (409 invalid_idempotent_request: for example the recipient list was changed mid-retry), retrying under the same
 * key can never succeed, so the next attempt uses a fresh key. That can duplicate an email that was in fact delivered, which
 * the design tolerates; losing an alert it does not.
 */
export const IDEMPOTENCY_MISMATCH_CODE = "invalid_idempotent_request";
function idempotencyKeyFor(alert: ClaimedAlert): string {
  const base = `operator-alert-${alert.id}`;
  return alert.lastErrorCode === IDEMPOTENCY_MISMATCH_CODE ? `${base}-r${alert.attemptNo}` : base;
}

/** Provider error codes are stored and logged: keep them short and free of anything that could echo input. */
function safeCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60) || "unknown";
}

export function createAlertService(deps: AlertServiceDeps): AlertService {
  const { db, sender, logger, config } = deps;
  const random = deps.random ?? Math.random;

  async function attemptSend(alert: ClaimedAlert, startedAt: Date, startedMs: number): Promise<Disposition> {
    const context = await loadAlertContext(db, alert.leadId);
    if (!context) {
      // Impossible while the foreign key holds; if it ever happens there is nothing to alert about.
      await db.transaction().execute(async (trx) => {
        if (await markFailed(trx, { alertId: alert.id, attemptNo: alert.attemptNo, errorCode: "lead_missing", retryInMs: null })) {
          await insertAttempt(trx, { alertId: alert.id, attemptNo: alert.attemptNo, startedAt, outcome: "permanent_failure", errorCode: "lead_missing", latencyMs: 0 });
        }
      });
      logger.error({ alertId: alert.id, leadId: alert.leadId }, "operator alert references a lead that does not exist");
      return "dead";
    }

    // A reminder is only useful while the lead still needs someone. Check at send time, not at
    // creation time, so a lead handled in the meantime never produces a pointless nag.
    if (alert.kind === "reminder" && !(await leadNeedsAttention(db, alert.leadId))) {
      await markCancelled(db, { alertId: alert.id, attemptNo: alert.attemptNo });
      return "cancelled";
    }

    let result: SendResult;
    let timedOut = false;
    if (config.recipients.length === 0) {
      // A configuration problem, not a provider one: retry (someone may fix the setting) and shout.
      result = { outcome: "retryable_failure", errorCode: "no_recipients" };
    } else {
      const { subject, text } = buildAlertMessage(alert.kind, context, {
        brandName: config.brandName,
        adminBaseUrl: config.adminBaseUrl,
        reminderAfterMinutes: config.reminderAfterMinutes,
      });
      try {
        result = await sender.send(
          { to: config.recipients, subject, text, idempotencyKey: idempotencyKeyFor(alert) },
          { signal: AbortSignal.timeout(config.sendTimeoutMs) },
        );
      } catch (error) {
        timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        result = { outcome: "retryable_failure", errorCode: timedOut ? "timeout" : "sender_exception" };
      }
    }
    if (result.outcome !== "accepted" && result.errorCode === "timeout") timedOut = true;

    const latencyMs = Math.round(performance.now() - startedMs);
    const attempt = {
      alertId: alert.id,
      attemptNo: alert.attemptNo,
      startedAt,
      latencyMs,
    };

    if (result.outcome === "accepted") {
      const recorded = await db.transaction().execute(async (trx) => {
        if (!(await markSent(trx, { alertId: alert.id, attemptNo: alert.attemptNo, providerMessageId: result.providerMessageId }))) {
          return false;
        }
        await insertAttempt(trx, { ...attempt, outcome: "accepted" });
        return true;
      });
      if (!recorded) {
        // Our lease was reclaimed while the provider call was in flight. The provider-side
        // idempotency key keeps the retry from sending a second email; nothing more to record.
        logger.warn({ alertId: alert.id, leadId: alert.leadId, attemptNo: alert.attemptNo }, "operator alert sent after its lease was reclaimed");
        return "lost";
      }
      logger.info(
        {
          alertId: alert.id,
          leadId: alert.leadId,
          kind: alert.kind,
          attemptNo: alert.attemptNo,
          sendMs: latencyMs,
          // Lead stored -> provider accepted: the number the "< 10 s" objective is measured by.
          leadToAlertMs: Date.now() - context.createdAt.getTime(),
        },
        "operator alert sent",
      );
      return "sent";
    }

    const errorCode = safeCode(result.errorCode);
    const exhausted = alert.attemptNo >= alert.maxAttempts;
    const permanent = result.outcome === "permanent_failure";
    const giveUp = permanent || exhausted;
    const retryInMs = giveUp ? null : retryDelayMs(alert.attemptNo, random);

    const recorded = await db.transaction().execute(async (trx) => {
      if (!(await markFailed(trx, { alertId: alert.id, attemptNo: alert.attemptNo, errorCode, retryInMs }))) return false;
      await insertAttempt(trx, {
        ...attempt,
        outcome: permanent ? "permanent_failure" : timedOut ? "timeout" : "retryable_failure",
        errorCode,
        httpStatus: result.httpStatus,
      });
      return true;
    });
    if (!recorded) return "lost";

    const fields = { alertId: alert.id, leadId: alert.leadId, kind: alert.kind, attemptNo: alert.attemptNo, errorCode, httpStatus: result.httpStatus };
    if (giveUp) {
      // The one alert-pipeline event that needs a human: /api/pipeline reports it until the lead is handled.
      logger.error({ ...fields, permanent }, "operator alert is dead: it will not be retried");
      return "dead";
    }
    logger.warn({ ...fields, retryInMs }, "operator alert failed, will retry");
    return "retrying";
  }

  async function processOne(alert: ClaimedAlert): Promise<Disposition | "error"> {
    const startedAt = new Date();
    const startedMs = performance.now();
    try {
      return await attemptSend(alert, startedAt, startedMs);
    } catch (error) {
      // Bookkeeping failed (database blip). The alert stays `sending`; its lease expires and the
      // reconciler requeues it. Failing safe is the whole point of the lease.
      logger.error({ err: error, alertId: alert.id, leadId: alert.leadId }, "operator alert processing failed; the lease will expire and it will be retried");
      return "error";
    }
  }

  async function processDue(): Promise<ProcessSummary> {
    const claimed = await claimDueAlerts(db, { limit: config.batchSize, leaseSeconds: config.leaseSeconds });
    if (claimed.length === 0) return EMPTY;
    const outcomes = await Promise.all(claimed.map(processOne));
    const count = (kind: Disposition | "error") => outcomes.filter((outcome) => outcome === kind).length;
    return { claimed: claimed.length, sent: count("sent"), retrying: count("retrying"), dead: count("dead"), cancelled: count("cancelled") };
  }

  async function reconcile(): Promise<ReconcileSummary> {
    const reclaimed = await reclaimExpiredLeases(db);
    const missingCreated = await enqueueMissingAlerts(db, { graceSeconds: config.graceSeconds, lookbackHours: config.lookbackHours });
    const remindersCreated = await enqueueReminders(db, { afterMinutes: config.reminderAfterMinutes, lookbackHours: config.lookbackHours });

    if (reclaimed.requeued + reclaimed.dead > 0) {
      logger.warn({ ...reclaimed }, "reclaimed operator alerts whose worker disappeared mid-send");
    }
    if (missingCreated > 0) {
      logger.error({ count: missingCreated }, "reconciler created operator alerts that should already exist: the enqueue path is broken or these leads predate it");
    }
    if (remindersCreated > 0) logger.info({ count: remindersCreated }, "queued reminders for unhandled leads");
    if (reclaimed.requeued + missingCreated + remindersCreated > 0) await notifyAlertsDue(db);

    return { requeued: reclaimed.requeued, dead: reclaimed.dead, missingCreated, remindersCreated };
  }

  return { processDue, reconcile };
}
