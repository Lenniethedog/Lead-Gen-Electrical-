import type { Logger } from "pino";
import { DELIVERY_POLICY } from "@/config/delivery";
import { LEAD_EVENT } from "@/config/lead-events";
import { setSystemContext } from "@/lib/db/audit-context";
import type { Database } from "@/lib/db/client";
import { decryptSecret } from "@/lib/secrets";
import { IDEMPOTENCY_MISMATCH_CODE, retryDelayMs } from "@/modules/alerts";
import { activeAssignmentsForLead, buildHandoverMessage, lockLead, transitionAssignment, transitionLead } from "@/modules/assignments";
import { writeAudit } from "@/modules/audit";
import type { Operator } from "@/modules/inbox";
import { buildSmsBody, buildWebhookBody, WEBHOOK_EVENT, type DeliveryData } from "./messages";
import type { ChannelSenders, SendResult } from "./ports";
import {
  assignmentsToSettle, claimDue, findNotificationByProviderId, insertAttempt, insertProviderEvent, leadIdOfAssignment, loadDeliveryData, markCancelled, markEventProcessed, markFailed,
  markSent, notificationsForLead, setWebhookHealth, problemNotifications, reclaimExpiredLeases, recordLeadEvent, requeue, setDelivered, setUndelivered, statusesForAssignment, unprocessedEvents,
  type ClaimedNotification,
} from "./repo";

export interface DeliveryServiceConfig {
  brandName: string;
  /** How long a worker may hold a notification before the reconciler takes it back. */
  leaseSeconds: number;
  /** Hard ceiling on one email/SMS call. Comfortably below leaseSeconds. */
  sendTimeoutMs: number;
  /** Notifications claimed per batch, sent in parallel (processDue). */
  batchSize: number;
  /** Most notifications this process has in flight at once (pump). A business whose server hangs holds ONE slot for up to the timeout, not the whole queue. Default 20. */
  maxInFlight?: number;
  /** Decrypts stored webhook secrets. Without it a webhook notification cannot be sent (retryable, and reported). */
  secretsKey?: Buffer | undefined;
}

export interface DeliveryServiceDeps {
  db: Database;
  senders: ChannelSenders;
  logger: Logger;
  config: DeliveryServiceConfig;
  random?: () => number;
}

export interface DeliverySummary {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
  cancelled: number;
}

export type RetryResult = { ok: true } | { ok: false; code: "not_found" | "not_retryable" | "assignment_ended" };

export type ProviderEventResult = "applied" | "duplicate" | "unmatched" | "ignored";

const EMPTY: DeliverySummary = { claimed: 0, sent: 0, retrying: 0, failed: 0, cancelled: 0 };
type Disposition = "sent" | "retrying" | "failed" | "cancelled" | "lost" | "error";

const safeCode = (code: string): string => code.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60) || "unknown";

/** Stable per notification so a retry after "accepted but we never heard" gets the original answer; rotated only on the provider's payload-mismatch 409 (as for alerts). */
function idempotencyKeyFor(notification: ClaimedNotification): string {
  const base = `delivery-${notification.id}`;
  return notification.lastErrorCode === IDEMPOTENCY_MISMATCH_CODE ? `${base}-r${notification.attemptNo}` : base;
}

export function createDeliveryService(deps: DeliveryServiceDeps) {
  const { db, senders, logger, config } = deps;
  const random = deps.random ?? Math.random;
  const maxInFlight = config.maxInFlight ?? 20;
  const inFlight = new Set<Promise<unknown>>();

  /**
   * Decides what an assignment's notifications mean for the assignment, under the lead lock (lock order is ALWAYS lead, assignment, notification):
   *   any channel accepted        -> the business has been told: reserved -> notified
   *   every channel gave up       -> reserved -> delivery_failed, the lead is free again (the router, or a person, takes it from there)
   * Idempotent: it only acts on a `reserved` assignment, so calling it twice, or from two workers, does nothing the second time.
   */
  async function settle(trx: Database, assignmentId: string, leadId: string): Promise<void> {
    const statuses = await statusesForAssignment(trx, assignmentId);
    const requestId = `delivery-${assignmentId}`;
    if (statuses.some((status) => status === "sent" || status === "delivered")) {
      await setSystemContext(trx, { requestId, reason: "delivered_automatically" });
      await transitionAssignment(trx, assignmentId, "reserved", "notified");
      return;
    }
    // Nothing has gone out. Only when EVERY channel has finished, and at least one really failed (all cancelled means the assignment ended another way).
    if (statuses.length === 0 || statuses.some((status) => status === "pending" || status === "sending" || status === "retrying")) return;
    if (!statuses.some((status) => status === "failed" || status === "dead")) return;
    await setSystemContext(trx, { requestId, reason: "delivery_failed" });
    if (!(await transitionAssignment(trx, assignmentId, "reserved", "delivery_failed"))) return;
    if ((await activeAssignmentsForLead(trx, leadId)).length === 0) await transitionLead(trx, leadId, "assigned", "new");
    await recordLeadEvent(trx, { leadId, type: LEAD_EVENT.deliveryFailed, requestId, payload: { assignment_id: assignmentId } });
    logger.error({ assignmentId, leadId }, "delivery failed on every channel: the assignment ended and the lead is free again");
  }

  /** Runs `change` and, if it applied, settles the assignment: all under the lead lock. Returns false when the change did not apply (a lost lease). */
  async function complete(notification: { assignmentId: string }, leadId: string, change: (trx: Database) => Promise<boolean>): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      await lockLead(trx, leadId);
      if (!(await change(trx))) return false;
      await settle(trx, notification.assignmentId, leadId);
      return true;
    });
  }

  async function buildAndSend(notification: ClaimedNotification, data: DeliveryData): Promise<SendResult> {
    const signal = AbortSignal.timeout(notification.channel === "webhook" ? DELIVERY_POLICY.webhookTimeoutMs : config.sendTimeoutMs);
    switch (notification.channel) {
      case "email": {
        const { subject, text } = buildHandoverMessage(
          { reference: data.reference, serviceLabel: data.serviceLabel, urgency: data.urgency, propertyType: data.propertyType, ownership: data.ownership, scope: data.scope, postcode: data.postcode, contact: data.contact, client: { name: data.client.name, contactName: data.client.contactName } },
          config.brandName,
        );
        return senders.email.send({ to: [data.client.contactEmail], subject, text, idempotencyKey: idempotencyKeyFor(notification) }, { signal });
      }
      case "sms": {
        if (!senders.sms) return { outcome: "retryable_failure", errorCode: "channel_not_configured" };
        if (!data.client.contactPhone) return { outcome: "permanent_failure", errorCode: "no_phone_number" };
        return senders.sms.send({ to: data.client.contactPhone, body: buildSmsBody(data, config.brandName), notificationId: notification.id }, { signal });
      }
      case "webhook": {
        if (!senders.webhook || !config.secretsKey) return { outcome: "retryable_failure", errorCode: "channel_not_configured" };
        if (!data.client.webhookUrl || !data.client.webhookSecretEnc) return { outcome: "permanent_failure", errorCode: "webhook_not_configured" };
        let secret: string;
        try {
          secret = decryptSecret(config.secretsKey, data.client.webhookSecretEnc);
        } catch {
          return { outcome: "retryable_failure", errorCode: "secret_unreadable" }; // a wrong key is a configuration problem a person can fix: never send unsigned, never give up
        }
        return senders.webhook.send({ url: data.client.webhookUrl, secret, body: buildWebhookBody(data), deliveryId: notification.id, event: WEBHOOK_EVENT }, { signal });
      }
    }
  }

  async function attempt(notification: ClaimedNotification, startedAt: Date, startedMs: number): Promise<Disposition> {
    const loaded = await loadDeliveryData(db, notification.id);
    if (!loaded.ok) {
      const leadId = loaded.leadId ?? (await leadIdOfAssignment(db, notification.assignmentId));
      if (!leadId) {
        await markFailed(db, { id: notification.id, attemptNo: notification.attemptNo, errorCode: "assignment_missing", retryInMs: null, permanent: true });
        return "failed";
      }
      // The assignment ended, the lead was erased or consent was withdrawn since this was queued: it must not go out. Not a failure.
      const done = await complete(notification, leadId, (trx) => markCancelled(trx, { id: notification.id, attemptNo: notification.attemptNo, reason: loaded.reason }));
      logger.info({ notificationId: notification.id, reason: loaded.reason }, "notification cancelled before sending");
      return done ? "cancelled" : "lost";
    }
    const { data, leadId } = loaded;

    let result: SendResult;
    let timedOut = false;
    try {
      result = await buildAndSend(notification, data);
    } catch (error) {
      timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      result = { outcome: "retryable_failure", errorCode: timedOut ? "timeout" : "sender_exception" };
    }
    if (result.outcome !== "accepted" && result.errorCode === "timeout") timedOut = true;
    const latencyMs = Math.round(performance.now() - startedMs);
    const base = { notificationId: notification.id, attemptNo: notification.attemptNo, startedAt, latencyMs };

    if (result.outcome === "accepted") {
      const recorded = await complete(notification, leadId, async (trx) => {
        if (!(await markSent(trx, { id: notification.id, attemptNo: notification.attemptNo, providerMessageId: result.providerMessageId }))) return false;
        await insertAttempt(trx, { ...base, outcome: "accepted" });
        if (notification.channel === "webhook") await setWebhookHealth(trx, data.client.id, false);
        return true;
      });
      if (!recorded) {
        logger.warn({ notificationId: notification.id, channel: notification.channel }, "notification sent after its lease was reclaimed");
        return "lost";
      }
      logger.info({ notificationId: notification.id, assignmentId: notification.assignmentId, channel: notification.channel, attemptNo: notification.attemptNo, sendMs: latencyMs, leadToDeliveryMs: Date.now() - data.createdAt.getTime() }, "notification sent");
      return "sent";
    }

    const errorCode = safeCode(result.errorCode);
    const permanent = result.outcome === "permanent_failure";
    const giveUp = permanent || notification.attemptNo >= notification.maxAttempts;
    const retryInMs = giveUp ? null : retryDelayMs(notification.attemptNo, random);
    const recorded = await complete(notification, leadId, async (trx) => {
      if (!(await markFailed(trx, { id: notification.id, attemptNo: notification.attemptNo, errorCode, retryInMs, permanent }))) return false;
      await insertAttempt(trx, { ...base, outcome: permanent ? "permanent_failure" : timedOut ? "timeout" : "retryable_failure", errorCode, httpStatus: result.httpStatus });
      if (giveUp && notification.channel === "webhook") await setWebhookHealth(trx, data.client.id, true);
      return true;
    });
    if (!recorded) return "lost";
    const fields = { notificationId: notification.id, assignmentId: notification.assignmentId, channel: notification.channel, attemptNo: notification.attemptNo, errorCode, httpStatus: result.httpStatus };
    if (giveUp) {
      logger.error({ ...fields, permanent }, "notification gave up: it will not be retried unless a person retries it");
      return "failed";
    }
    logger.warn({ ...fields, retryInMs }, "notification failed, will retry");
    return "retrying";
  }

  async function processOne(notification: ClaimedNotification): Promise<Disposition> {
    const startedAt = new Date();
    const startedMs = performance.now();
    try {
      return await attempt(notification, startedAt, startedMs);
    } catch (error) {
      // Bookkeeping failed (database blip): it stays `sending`, the lease expires and the reconciler requeues it.
      logger.error({ err: error, notificationId: notification.id }, "notification processing failed; the lease will expire and it will be retried");
      return "error";
    }
  }

  async function applyEvent(trx: Database, eventRowId: number, event: { sid: string; status: string; errorCode: string | null }): Promise<boolean> {
    const found = await findNotificationByProviderId(trx, event.sid);
    if (!found) return false; // the callback beat our own bookkeeping: left unprocessed; the reconciler applies it later
    await lockLead(trx, found.leadId);
    if (event.status === "delivered") await setDelivered(trx, found.id);
    else if (event.status === "undelivered" || event.status === "failed") {
      if (await setUndelivered(trx, found.id, safeCode(`twilio_${event.errorCode ?? event.status}`))) await settle(trx, found.assignmentId, found.leadId);
    }
    await markEventProcessed(trx, eventRowId);
    return true;
  }

  return {
    /** Claims one batch of due notifications and sends them. Call repeatedly until it returns `claimed: 0`. */
    async processDue(): Promise<DeliverySummary> {
      const claimed = await claimDue(db, { limit: config.batchSize, leaseSeconds: config.leaseSeconds });
      if (claimed.length === 0) return EMPTY;
      const outcomes = await Promise.all(claimed.map(processOne));
      const count = (kind: Disposition) => outcomes.filter((outcome) => outcome === kind).length;
      return { claimed: claimed.length, sent: count("sent"), retrying: count("retrying"), failed: count("failed"), cancelled: count("cancelled") };
    },

    /**
     * The worker's entry point: claims as many due notifications as there are free slots and STARTS them, returning how many it started
     * without waiting for them. So one slow or hung provider call occupies one slot and nothing else waits for it (the lease, not this
     * loop, is what protects a notification whose call never returns). Call again while it returns more than zero.
     */
    async pump(): Promise<number> {
      const free = maxInFlight - inFlight.size;
      if (free <= 0) return 0;
      const claimed = await claimDue(db, { limit: free, leaseSeconds: config.leaseSeconds });
      for (const notification of claimed) {
        const running: Promise<unknown> = processOne(notification).finally(() => inFlight.delete(running));
        inFlight.add(running);
      }
      return claimed.length;
    },

    /** Resolves when everything this process has in flight has finished (graceful shutdown waits on it, bounded). */
    async settled(): Promise<void> {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },

    /** Idempotent safety net; safe from any number of workers at once. */
    async reconcile(): Promise<{ requeued: number; dead: number; settled: number; eventsApplied: number }> {
      const reclaimed = await reclaimExpiredLeases(db);
      if (reclaimed.requeued + reclaimed.dead > 0) logger.warn({ ...reclaimed }, "reclaimed notifications whose worker disappeared mid-send");

      // A notification can reach `dead` without anyone settling its assignment (a lease that expired on the last attempt).
      let settled = 0;
      for (const { assignmentId, leadId } of await assignmentsToSettle(db, 50)) {
        await db.transaction().execute(async (trx) => {
          await lockLead(trx, leadId);
          await settle(trx, assignmentId, leadId);
        });
        settled += 1;
      }

      // Provider callbacks that arrived before we had recorded the message id.
      let eventsApplied = 0;
      for (const event of await unprocessedEvents(db, 50)) {
        const applied = await db.transaction().execute((trx) => applyEvent(trx, event.id, { sid: event.providerMessageId, status: event.status, errorCode: event.errorCode }));
        if (applied) eventsApplied += 1;
      }
      return { requeued: reclaimed.requeued, dead: reclaimed.dead, settled, eventsApplied };
    },

    /** A provider's delivery report, verified by the caller. Each (provider, event) is applied once; out-of-order and repeated reports are harmless. */
    async applyProviderEvent(input: { provider: "twilio"; eventId: string; sid: string; status: string; errorCode: string | null }): Promise<ProviderEventResult> {
      return db.transaction().execute(async (trx): Promise<ProviderEventResult> => {
        const rowId = await insertProviderEvent(trx, { provider: input.provider, eventId: input.eventId, providerMessageId: input.sid, status: input.status.slice(0, 40), errorCode: input.errorCode?.slice(0, 40) ?? null });
        if (rowId === undefined) return "duplicate";
        const applied = await applyEvent(trx, rowId, { sid: input.sid, status: input.status, errorCode: input.errorCode });
        return applied ? (["delivered", "undelivered", "failed"].includes(input.status) ? "applied" : "ignored") : "unmatched";
      });
    },

    /** A person puts a failed or dead notification back in the queue. Only while its assignment is still active. */
    async retry(input: { operator: Operator; notificationId: string; requestId: string }): Promise<RetryResult> {
      return db.transaction().execute(async (trx): Promise<RetryResult> => {
        const result = await requeue(trx, input.notificationId);
        if (!result.ok) return { ok: false, code: result.reason };
        await writeAudit(trx, { actorId: input.operator.id, action: "delivery.retried", entityType: "notification", entityId: input.notificationId, requestId: input.requestId });
        return { ok: true };
      });
    },

    forLead: (leadId: string) => notificationsForLead(db, leadId),
    problems: () => problemNotifications(db),
  };
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
