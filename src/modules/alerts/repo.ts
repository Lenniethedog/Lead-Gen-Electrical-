import { sql } from "kysely";
import { ALERT_POLICY } from "@/config/lead-events";
import type { Database } from "@/lib/db/client";
import { needsAPerson } from "@/lib/db/lead-predicates";
import type { OperatorAlertKind } from "@/lib/db/schema";
import type { AlertLeadContext } from "./message";

/**
 * ALL queue SQL for operator alerts. Every function takes a `Database`, which may be a transaction;
 * the service decides transaction boundaries. Swapping the transport for a managed queue later
 * means replacing this file (and nothing else): the outbox rows are the contract.
 *
 * Concurrency model: any number of workers may run these at once. Claiming uses FOR UPDATE SKIP
 * LOCKED, every state change is a compare-and-set on (status, attempt_count), and creation is
 * ON CONFLICT DO NOTHING, so a repeated or racing call is harmless.
 */

/** Postgres LISTEN/NOTIFY channel that wakes workers the moment an alert is enqueued. */
export const ALERTS_CHANNEL = "operator_alerts_due";

export interface ClaimedAlert {
  id: string;
  leadId: string;
  kind: OperatorAlertKind;
  /** 1-based number of the attempt this claim represents. */
  attemptNo: number;
  maxAttempts: number;
  /** Why the PREVIOUS attempt failed (null on the first). The service uses it to rotate the idempotency key. */
  lastErrorCode: string | null;
}

const updated = (result: { numUpdatedRows: bigint }) => result.numUpdatedRows > 0n;

// ------------------------------------------------------------------------------------------------
// Enqueue (called inside the lead's own transaction)
// ------------------------------------------------------------------------------------------------

/** Creates the alert unless this lead already has one of this kind. True if a row was created. */
export async function enqueueAlert(db: Database, input: { leadId: string; kind: OperatorAlertKind }): Promise<boolean> {
  const result = await db
    .insertInto("operator_alerts")
    .values({ lead_id: input.leadId, kind: input.kind })
    .onConflict((conflict) => conflict.columns(["lead_id", "kind"]).doNothing())
    .executeTakeFirst();
  return (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
}

/** Wakes listening workers. Inside a transaction the notification is delivered at COMMIT. */
export async function notifyAlertsDue(db: Database): Promise<void> {
  await sql`select pg_notify(${ALERTS_CHANNEL}, '')`.execute(db);
}

// ------------------------------------------------------------------------------------------------
// Claim and complete (the worker)
// ------------------------------------------------------------------------------------------------

/**
 * Takes up to `limit` due alerts, marking them `sending` with a lease. The lease is what makes a
 * crashed worker harmless: if it never finishes, the reconciler hands the alert to someone else
 * once `locked_until` passes. (MATERIALIZED stops the planner re-running the locking subquery.)
 */
export async function claimDueAlerts(db: Database, input: { limit: number; leaseSeconds: number }): Promise<ClaimedAlert[]> {
  const { rows } = await sql<{
    id: string;
    lead_id: string;
    kind: OperatorAlertKind;
    attempt_count: number;
    max_attempts: number;
    last_error_code: string | null;
  }>`
    with due as materialized (
      select id from operator_alerts
      where status in ('pending', 'retrying') and next_attempt_at <= now()
      order by next_attempt_at
      for update skip locked
      limit ${input.limit}
    )
    update operator_alerts a
       set status = 'sending',
           attempt_count = a.attempt_count + 1,
           locked_until = now() + make_interval(secs => ${input.leaseSeconds})
      from due
     where a.id = due.id
    returning a.id, a.lead_id, a.kind, a.attempt_count, a.max_attempts, a.last_error_code`.execute(db);
  return rows.map((row) => ({
    id: row.id,
    leadId: row.lead_id,
    kind: row.kind,
    attemptNo: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastErrorCode: row.last_error_code,
  }));
}

/** Everything the message needs, read WITHOUT touching lead_contacts. */
export async function loadAlertContext(db: Database, leadId: string): Promise<AlertLeadContext | undefined> {
  const row = await db
    .selectFrom("leads as l")
    .innerJoin("service_types as s", "s.id", "l.service_type_id")
    .select([
      "l.id",
      "l.reference",
      "s.label as service_label",
      "l.postcode_outward",
      "l.urgency",
      "l.fraud_score",
      "l.fraud_decision",
      "l.created_at",
    ])
    .where("l.id", "=", leadId)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    leadId: row.id,
    reference: row.reference,
    serviceLabel: row.service_label,
    postcodeOutward: row.postcode_outward,
    urgency: row.urgency,
    fraudScore: row.fraud_score,
    fraudDecision: row.fraud_decision,
    createdAt: row.created_at,
  };
}

/** A lead still needs a person (the inbox's "Needs action": held, new/unroutable and unhandled, or assigned and not yet sent). */
export async function leadNeedsAttention(db: Database, leadId: string): Promise<boolean> {
  const { rows } = await sql<{ needs: boolean }>`
    select exists (
      select 1 from leads l
       where l.id = ${leadId} and l.deleted_at is null and ${needsAPerson}
    ) as needs`.execute(db);
  return rows[0]?.needs ?? false;
}

interface AttemptRecord {
  alertId: string;
  attemptNo: number;
  startedAt: Date;
  outcome: "accepted" | "retryable_failure" | "permanent_failure" | "timeout";
  errorCode?: string | undefined;
  httpStatus?: number | undefined;
  latencyMs: number;
}

/** One row per finished attempt. A duplicate for the same (alert, attempt) is ignored. */
export async function insertAttempt(db: Database, attempt: AttemptRecord): Promise<void> {
  await db
    .insertInto("operator_alert_attempts")
    .values({
      alert_id: attempt.alertId,
      attempt_no: attempt.attemptNo,
      started_at: attempt.startedAt,
      outcome: attempt.outcome,
      error_code: attempt.errorCode ?? null,
      http_status: attempt.httpStatus ?? null,
      latency_ms: attempt.latencyMs,
    })
    .onConflict((conflict) => conflict.columns(["alert_id", "attempt_no"]).doNothing())
    .execute();
}

/**
 * The three completions are compare-and-set on (status = 'sending', attempt_count): a worker whose
 * lease was reclaimed (it stalled, or the process was frozen) can no longer overwrite the newer
 * state. They return false when that happens, and the caller must not record anything else.
 */
export async function markSent(
  db: Database,
  input: { alertId: string; attemptNo: number; providerMessageId?: string | undefined },
): Promise<boolean> {
  const result = await db
    .updateTable("operator_alerts")
    .set({
      status: "sent",
      sent_at: sql<Date>`now()`,
      locked_until: null,
      last_error_code: null,
      provider_message_id: input.providerMessageId ?? null,
    })
    .where("id", "=", input.alertId)
    .where("status", "=", "sending")
    .where("attempt_count", "=", input.attemptNo)
    .executeTakeFirst();
  return updated(result);
}

/** `retryInMs: null` means give up (dead); otherwise try again after that delay. */
export async function markFailed(
  db: Database,
  input: { alertId: string; attemptNo: number; errorCode: string; retryInMs: number | null },
): Promise<boolean> {
  const result = await db
    .updateTable("operator_alerts")
    .set({
      status: input.retryInMs === null ? "dead" : "retrying",
      locked_until: null,
      last_error_code: input.errorCode,
      ...(input.retryInMs !== null && { next_attempt_at: sql<Date>`now() + make_interval(secs => ${input.retryInMs / 1000})` }),
    })
    .where("id", "=", input.alertId)
    .where("status", "=", "sending")
    .where("attempt_count", "=", input.attemptNo)
    .executeTakeFirst();
  return updated(result);
}

export async function markCancelled(db: Database, input: { alertId: string; attemptNo: number }): Promise<boolean> {
  const result = await db
    .updateTable("operator_alerts")
    .set({ status: "cancelled", locked_until: null })
    .where("id", "=", input.alertId)
    .where("status", "=", "sending")
    .where("attempt_count", "=", input.attemptNo)
    .executeTakeFirst();
  return updated(result);
}

// ------------------------------------------------------------------------------------------------
// Reconciler: the safety net under everything above
// ------------------------------------------------------------------------------------------------

/**
 * Hands alerts whose worker disappeared back to the queue (or buries them if they have used all
 * their attempts). The lost attempt is recorded as 'abandoned' so the history is complete.
 */
export async function reclaimExpiredLeases(db: Database): Promise<{ requeued: number; dead: number }> {
  const { rows } = await sql<{ status: string }>`
    with expired as (
      select id, attempt_count, updated_at from operator_alerts
       where status = 'sending' and locked_until < now()
       for update skip locked
    ), lost as (
      insert into operator_alert_attempts (alert_id, attempt_no, started_at, outcome, error_code)
      select id, attempt_count, updated_at, 'abandoned', 'lease_expired' from expired
      on conflict (alert_id, attempt_no) do nothing
      returning 1
    )
    update operator_alerts a
       set status = (case when a.attempt_count >= a.max_attempts then 'dead' else 'retrying' end)::operator_alert_status,
           locked_until = null,
           next_attempt_at = now(),
           last_error_code = 'lease_expired'
      from expired
     where a.id = expired.id
    returning a.status`.execute(db);
  return {
    requeued: rows.filter((row) => row.status === "retrying").length,
    dead: rows.filter((row) => row.status === "dead").length,
  };
}

/**
 * New/held leads with no alert at all. In normal operation this returns nothing, because the alert
 * is written in the lead's own transaction; a non-empty result means a lead predates the outbox or
 * the enqueue path is broken, which is why the caller logs it loudly.
 */
export async function enqueueMissingAlerts(
  db: Database,
  input: { graceSeconds: number; lookbackHours: number },
): Promise<number> {
  const { rows } = await sql`
    insert into operator_alerts (lead_id, kind)
    select l.id, (case when l.status = 'held' then 'held_lead' else 'new_lead' end)::operator_alert_kind
      from leads l
     where l.status in ('new', 'held') and l.deleted_at is null and not l.is_test
       and l.created_at < now() - make_interval(secs => ${input.graceSeconds})
       and l.created_at > now() - make_interval(hours => ${input.lookbackHours})
       and not exists (select 1 from operator_alerts a where a.lead_id = l.id and a.kind in ('new_lead', 'held_lead'))
    on conflict (lead_id, kind) do nothing
    returning lead_id`.execute(db);
  return rows.length;
}

/** One reminder per lead that is still unhandled after `afterMinutes` (and has had its first alert). */
export async function enqueueReminders(
  db: Database,
  input: { afterMinutes: number; lookbackHours: number },
): Promise<number> {
  const { rows } = await sql`
    insert into operator_alerts (lead_id, kind)
    select l.id, 'reminder'
      from leads l
     where l.deleted_at is null and not l.is_test and ${needsAPerson}
       and l.created_at < now() - make_interval(mins => ${input.afterMinutes})
       and l.created_at > now() - make_interval(hours => ${input.lookbackHours})
       and exists (select 1 from operator_alerts a where a.lead_id = l.id and a.kind in ('new_lead', 'held_lead'))
    on conflict (lead_id, kind) do nothing
    returning lead_id`.execute(db);
  return rows.length;
}

// ------------------------------------------------------------------------------------------------
// Liveness and health
// ------------------------------------------------------------------------------------------------

export async function recordHeartbeat(db: Database, input: { workerId: string; reconciled: boolean }): Promise<void> {
  await db
    .insertInto("worker_heartbeats")
    .values({ worker_id: input.workerId })
    .onConflict((conflict) =>
      conflict.column("worker_id").doUpdateSet({
        last_beat_at: sql<Date>`now()`,
        ...(input.reconciled && { last_reconciled_at: sql<Date>`now()` }),
      }),
    )
    .execute();
}

export async function removeWorkerHeartbeat(db: Database, workerId: string): Promise<void> {
  await db.deleteFrom("worker_heartbeats").where("worker_id", "=", workerId).execute();
}

/** Forgets workers that have been silent for a day (old deployments), so the table stays tiny. */
export async function pruneHeartbeats(db: Database): Promise<void> {
  await sql`delete from worker_heartbeats where last_beat_at < now() - interval '1 day'`.execute(db);
}

export type PipelineProblem = "worker_stale" | "alerts_overdue" | "alerts_dead" | "leads_unalerted";

export interface PipelineHealth {
  ok: boolean;
  problems: PipelineProblem[];
}

/**
 * Is the alerting pipeline doing its job RIGHT NOW? Four independent questions, so one failure
 * mode cannot mask another. Counts only: this feeds a public endpoint.
 */
export async function getPipelineHealth(db: Database): Promise<PipelineHealth> {
  const policy = ALERT_POLICY;
  const { rows } = await sql<{ beat_age: number | null; overdue: number; dead: number; unalerted: number }>`
    select
      (select extract(epoch from now() - max(last_beat_at))::float8 from worker_heartbeats) as beat_age,
      (select count(*)::int from operator_alerts
        where (status in ('pending', 'retrying') and next_attempt_at < now() - make_interval(secs => ${policy.overdueSeconds}))
           or (status = 'sending' and locked_until < now() - make_interval(secs => ${policy.overdueSeconds}))) as overdue,
      (select count(*)::int from operator_alerts a join leads l on l.id = a.lead_id
        where a.status = 'dead' and ${needsAPerson}) as dead,
      (select count(*)::int from leads l
        where l.status in ('new', 'held') and l.deleted_at is null and not l.is_test
          and l.created_at < now() - make_interval(secs => ${policy.unalertedSeconds})
          and l.created_at > now() - make_interval(hours => ${policy.lookbackHours})
          and not exists (select 1 from operator_alerts a where a.lead_id = l.id and a.kind in ('new_lead', 'held_lead'))) as unalerted`.execute(
    db,
  );
  const row = rows[0]!;
  const problems: PipelineProblem[] = [];
  if (row.beat_age === null || row.beat_age > policy.workerStaleSeconds) problems.push("worker_stale");
  if (row.overdue > 0) problems.push("alerts_overdue");
  if (row.dead > 0) problems.push("alerts_dead");
  if (row.unalerted > 0) problems.push("leads_unalerted");
  return { ok: problems.length === 0, problems };
}
