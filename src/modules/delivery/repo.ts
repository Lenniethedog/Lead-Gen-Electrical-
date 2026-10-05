import { sql } from "kysely";
import { DELIVERY_POLICY } from "@/config/delivery";
import type { Database } from "@/lib/db/client";
import type { Urgency } from "@/config/lead-options";
import type { DeliveryData } from "./messages";

/** ALL SQL for the delivery outbox. Takes a `Database` (possibly a transaction); the service owns transaction boundaries. Same model as operator_alerts (src/modules/alerts/repo.ts). */

/** Postgres channel that wakes workers when a notification is created or retried. */
export const NOTIFICATIONS_CHANNEL = "notifications_due";

export type Channel = "email" | "sms" | "webhook";
export type NotificationStatus = "pending" | "sending" | "retrying" | "sent" | "delivered" | "failed" | "dead" | "cancelled";
const updated = (result: { numUpdatedRows: bigint }) => result.numUpdatedRows > 0n;

export interface ClaimedNotification {
  id: string;
  assignmentId: string;
  channel: Channel;
  attemptNo: number;
  maxAttempts: number;
  lastErrorCode: string | null;
}

export async function claimDue(db: Database, input: { limit: number; leaseSeconds: number }): Promise<ClaimedNotification[]> {
  const { rows } = await sql<{ id: string; assignment_id: string; channel: Channel; attempt_count: number; max_attempts: number; last_error_code: string | null }>`
    with due as materialized (
      select id from notifications
       where status in ('pending', 'retrying') and next_attempt_at <= now()
       order by next_attempt_at
       for update skip locked
       limit ${input.limit}
    )
    update notifications n
       set status = 'sending', attempt_count = n.attempt_count + 1, locked_until = now() + make_interval(secs => ${input.leaseSeconds})
      from due where n.id = due.id
    returning n.id, n.assignment_id, n.channel, n.attempt_count, n.max_attempts, n.last_error_code`.execute(db);
  return rows.map((row) => ({ id: row.id, assignmentId: row.assignment_id, channel: row.channel, attemptNo: row.attempt_count, maxAttempts: row.max_attempts, lastErrorCode: row.last_error_code }));
}

export type DeliveryDataResult = { ok: true; data: DeliveryData; leadId: string } | { ok: false; reason: "assignment_ended" | "lead_erased" | "consent_withdrawn" | "not_found"; leadId: string | null };

/** Everything a message needs. Refuses (with the reason) unless the assignment is active, the lead is not erased and consent was not withdrawn. */
export async function loadDeliveryData(db: Database, notificationId: string): Promise<DeliveryDataResult> {
  const { rows } = await sql<{
    assignment_id: string; assignment_status: string; lead_id: string; price_pence: number; reference: string; urgency: Urgency; property_type: string; ownership: string;
    details: { scope?: string } | null; postcode: string | null; postcode_outward: string; lead_erased: Date | null; lead_deleted: Date | null; created_at: Date; service_slug: string; service_label: string;
    full_name: string | null; phone_e164: string | null; email: string | null; notes: string | null; contact_erased: Date | null;
    client_id: string; client_name: string; contact_name: string | null; contact_email: string; contact_phone: string | null; webhook_url: string | null; webhook_secret_enc: string | null;
    withdrawn: boolean;
  }>`
    select a.id as assignment_id, a.status as assignment_status, a.lead_id, a.price_pence,
           l.reference, l.urgency, l.property_type, l.ownership, l.details, l.postcode, l.postcode_outward, l.erased_at as lead_erased, l.deleted_at as lead_deleted, l.created_at,
           st.slug as service_slug, st.label as service_label,
           lc.full_name, lc.phone_e164, lc.email, lc.notes, lc.erased_at as contact_erased,
           c.id as client_id, c.name as client_name, c.contact_name, c.contact_email, c.contact_phone_e164 as contact_phone, c.webhook_url, c.webhook_secret_enc,
           exists (select 1 from consent_records r where r.lead_id = l.id and r.event = 'withdrawn') as withdrawn
      from notifications n
      join lead_assignments a on a.id = n.assignment_id
      join leads l on l.id = a.lead_id
      join service_types st on st.id = l.service_type_id
      join clients c on c.id = a.client_id
      left join lead_contacts lc on lc.lead_id = l.id
     where n.id = ${notificationId}`.execute(db);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found", leadId: null };
  if (!["reserved", "notified", "accepted", "disputed"].includes(row.assignment_status)) return { ok: false, reason: "assignment_ended", leadId: row.lead_id };
  if (row.withdrawn) return { ok: false, reason: "consent_withdrawn", leadId: row.lead_id };
  if (row.lead_erased || row.lead_deleted || row.contact_erased || !row.postcode || !row.full_name || !row.phone_e164 || !row.email) return { ok: false, reason: "lead_erased", leadId: row.lead_id };
  return {
    ok: true,
    leadId: row.lead_id,
    data: {
      notificationId, assignmentId: row.assignment_id, leadId: row.lead_id, reference: row.reference, serviceSlug: row.service_slug, serviceLabel: row.service_label,
      scope: row.details?.scope ?? null, urgency: row.urgency, propertyType: row.property_type, ownership: row.ownership, postcode: row.postcode, postcodeOutward: row.postcode_outward,
      createdAt: row.created_at, pricePence: row.price_pence,
      contact: { name: row.full_name, phone: row.phone_e164, email: row.email, notes: row.notes },
      client: { id: row.client_id, name: row.client_name, contactName: row.contact_name, contactEmail: row.contact_email, contactPhone: row.contact_phone, webhookUrl: row.webhook_url, webhookSecretEnc: row.webhook_secret_enc },
    },
  };
}

export interface AttemptRecord {
  notificationId: string;
  attemptNo: number;
  startedAt: Date;
  outcome: "accepted" | "retryable_failure" | "permanent_failure" | "timeout" | "abandoned";
  errorCode?: string | undefined;
  httpStatus?: number | undefined;
  latencyMs: number;
}

export async function insertAttempt(db: Database, attempt: AttemptRecord): Promise<void> {
  await db
    .insertInto("notification_attempts")
    .values({ notification_id: attempt.notificationId, attempt_no: attempt.attemptNo, started_at: attempt.startedAt, outcome: attempt.outcome, error_code: attempt.errorCode ?? null, http_status: attempt.httpStatus ?? null, latency_ms: attempt.latencyMs })
    .onConflict((conflict) => conflict.columns(["notification_id", "attempt_no"]).doNothing())
    .execute();
}

/** Compare-and-set on (status = 'sending', attempt_count): a worker whose lease was reclaimed cannot overwrite the newer state. */
export async function markSent(db: Database, input: { id: string; attemptNo: number; providerMessageId?: string | undefined }): Promise<boolean> {
  return updated(
    await db.updateTable("notifications")
      .set({ status: "sent", sent_at: sql<Date>`now()`, locked_until: null, last_error_code: null, provider_message_id: input.providerMessageId ?? null })
      .where("id", "=", input.id).where("status", "=", "sending").where("attempt_count", "=", input.attemptNo).executeTakeFirst(),
  );
}

/** `retryInMs: null` gives up: `failed` for a permanent failure, `dead` for exhausted retries. */
export async function markFailed(db: Database, input: { id: string; attemptNo: number; errorCode: string; retryInMs: number | null; permanent: boolean }): Promise<boolean> {
  return updated(
    await db.updateTable("notifications")
      .set({
        status: input.retryInMs !== null ? "retrying" : input.permanent ? "failed" : "dead",
        locked_until: null, last_error_code: input.errorCode,
        ...(input.retryInMs !== null && { next_attempt_at: sql<Date>`now() + make_interval(secs => ${input.retryInMs / 1000})` }),
      })
      .where("id", "=", input.id).where("status", "=", "sending").where("attempt_count", "=", input.attemptNo).executeTakeFirst(),
  );
}

export async function markCancelled(db: Database, input: { id: string; attemptNo: number; reason: string }): Promise<boolean> {
  return updated(
    await db.updateTable("notifications").set({ status: "cancelled", locked_until: null, last_error_code: input.reason })
      .where("id", "=", input.id).where("status", "=", "sending").where("attempt_count", "=", input.attemptNo).executeTakeFirst(),
  );
}

/** Hands notifications whose worker disappeared back to the queue (or buries them if out of attempts); the lost attempt is recorded as `abandoned`. */
export async function reclaimExpiredLeases(db: Database): Promise<{ requeued: number; dead: number }> {
  const { rows } = await sql<{ status: string }>`
    with expired as (
      select id, attempt_count, updated_at from notifications where status = 'sending' and locked_until < now() for update skip locked
    ), lost as (
      insert into notification_attempts (notification_id, attempt_no, started_at, outcome, error_code)
      select id, attempt_count, updated_at, 'abandoned', 'lease_expired' from expired
      on conflict (notification_id, attempt_no) do nothing returning 1
    )
    update notifications n
       set status = (case when n.attempt_count >= n.max_attempts then 'dead' else 'retrying' end)::notification_status,
           locked_until = null, next_attempt_at = now(), last_error_code = 'lease_expired'
      from expired where n.id = expired.id
    returning n.status`.execute(db);
  return { requeued: rows.filter((row) => row.status === "retrying").length, dead: rows.filter((row) => row.status === "dead").length };
}

/** A business's webhook is "failing since" its first give-up, until one succeeds (or a new secret is issued). Shown on the client page; it never blocks sending. */
export async function setWebhookHealth(db: Database, clientId: string, failing: boolean): Promise<void> {
  if (failing) await sql`update clients set webhook_failing_since = coalesce(webhook_failing_since, now()) where id = ${clientId}`.execute(db);
  else await sql`update clients set webhook_failing_since = null where id = ${clientId} and webhook_failing_since is not null`.execute(db);
}

export async function statusesForAssignment(db: Database, assignmentId: string): Promise<NotificationStatus[]> {
  const rows = await db.selectFrom("notifications").select("status").where("assignment_id", "=", assignmentId).execute();
  return rows.map((row) => row.status);
}

export async function leadIdOfAssignment(db: Database, assignmentId: string): Promise<string | undefined> {
  return (await db.selectFrom("lead_assignments").select("lead_id").where("id", "=", assignmentId).executeTakeFirst())?.lead_id;
}

export async function recordLeadEvent(db: Database, input: { leadId: string; type: string; requestId: string; payload: Record<string, unknown> }): Promise<void> {
  await db.insertInto("lead_events").values({ lead_id: input.leadId, type: input.type, actor_type: "system", request_id: input.requestId, payload: JSON.stringify(input.payload) }).execute();
}

// ------------------------------------------------------------------------------------------------
// Reading (admin) and retrying
// ------------------------------------------------------------------------------------------------

export interface NotificationView {
  id: string;
  assignmentId: string;
  channel: Channel;
  status: NotificationStatus;
  attempts: number;
  maxAttempts: number;
  lastErrorCode: string | null;
  sentAt: Date | null;
  deliveredAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
}

const VIEW_COLUMNS = sql`n.id, n.assignment_id, n.channel, n.status, n.attempt_count, n.max_attempts, n.last_error_code, n.sent_at, n.delivered_at, n.next_attempt_at, n.created_at`;
type ViewRow = { id: string; assignment_id: string; channel: Channel; status: NotificationStatus; attempt_count: number; max_attempts: number; last_error_code: string | null; sent_at: Date | null; delivered_at: Date | null; next_attempt_at: Date; created_at: Date };
const toView = (row: ViewRow): NotificationView => ({
  id: row.id, assignmentId: row.assignment_id, channel: row.channel, status: row.status, attempts: row.attempt_count, maxAttempts: row.max_attempts, lastErrorCode: row.last_error_code,
  sentAt: row.sent_at, deliveredAt: row.delivered_at, nextAttemptAt: row.next_attempt_at, createdAt: row.created_at,
});

export async function notificationsForLead(db: Database, leadId: string): Promise<NotificationView[]> {
  const { rows } = await sql<ViewRow>`select ${VIEW_COLUMNS} from notifications n join lead_assignments a on a.id = n.assignment_id where a.lead_id = ${leadId} order by n.created_at, n.channel`.execute(db);
  return rows.map(toView);
}

export interface ProblemRow extends NotificationView {
  leadId: string;
  reference: string;
  clientName: string;
  assignmentStatus: string;
}

/** Failed or dead notifications from the look-back window, newest first: the "failed deliveries" queue. */
export async function problemNotifications(db: Database): Promise<ProblemRow[]> {
  const { rows } = await sql<ViewRow & { lead_id: string; reference: string; client_name: string; assignment_status: string }>`
    select ${VIEW_COLUMNS}, a.lead_id, l.reference, c.name as client_name, a.status as assignment_status
      from notifications n join lead_assignments a on a.id = n.assignment_id join leads l on l.id = a.lead_id join clients c on c.id = a.client_id
     where n.status in ('failed', 'dead') and n.updated_at > now() - make_interval(hours => ${DELIVERY_POLICY.lookbackHours})
     order by n.updated_at desc limit 100`.execute(db);
  return rows.map((row) => ({ ...toView(row), leadId: row.lead_id, reference: row.reference, clientName: row.client_name, assignmentStatus: row.assignment_status }));
}

/** Puts a failed/dead notification back in the queue (only while its assignment is still active). Compare-and-set on the status. */
export async function requeue(db: Database, notificationId: string): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_retryable" | "assignment_ended" }> {
  const { rows } = await sql<{ status: NotificationStatus; assignment_status: string }>`
    select n.status, a.status as assignment_status from notifications n join lead_assignments a on a.id = n.assignment_id where n.id = ${notificationId} for update of n`.execute(db);
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "failed" && row.status !== "dead") return { ok: false, reason: "not_retryable" };
  if (!["reserved", "notified", "accepted", "disputed"].includes(row.assignment_status)) return { ok: false, reason: "assignment_ended" };
  await sql`update notifications set status = 'pending', attempt_count = 0, next_attempt_at = now(), last_error_code = null where id = ${notificationId} and status in ('failed', 'dead')`.execute(db);
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------
// Provider callbacks
// ------------------------------------------------------------------------------------------------

/** Records a callback once. Returns the row id, or undefined if this exact event was already received (a replay). */
export async function insertProviderEvent(db: Database, input: { provider: string; eventId: string; providerMessageId: string | null; status: string; errorCode: string | null }): Promise<number | undefined> {
  const { rows } = await sql<{ id: string }>`
    insert into provider_events (provider, event_id, provider_message_id, status, error_code)
    values (${input.provider}, ${input.eventId}, ${input.providerMessageId}, ${input.status}, ${input.errorCode})
    on conflict (provider, event_id) do nothing returning id`.execute(db);
  return rows[0] ? Number(rows[0].id) : undefined;
}

export async function markEventProcessed(db: Database, id: number): Promise<void> {
  await sql`update provider_events set processed_at = now() where id = ${id}`.execute(db);
}

/** Without a lock: the caller locks the LEAD first (lead, then assignment, then notification is the order everywhere), then updates compare-and-set. */
export async function findNotificationByProviderId(db: Database, providerMessageId: string): Promise<{ id: string; assignmentId: string; leadId: string } | undefined> {
  const { rows } = await sql<{ id: string; assignment_id: string; lead_id: string }>`
    select n.id, n.assignment_id, a.lead_id from notifications n join lead_assignments a on a.id = n.assignment_id
     where n.provider_message_id = ${providerMessageId} and n.channel = 'sms'`.execute(db);
  return rows[0] && { id: rows[0].id, assignmentId: rows[0].assignment_id, leadId: rows[0].lead_id };
}

/** Reserved assignments whose notifications have ALL finished (none pending, sending or retrying): they can be settled now. */
export async function assignmentsToSettle(db: Database, limit: number): Promise<Array<{ assignmentId: string; leadId: string }>> {
  const { rows } = await sql<{ id: string; lead_id: string }>`
    select a.id, a.lead_id from lead_assignments a
     where a.status = 'reserved'
       and exists (select 1 from notifications n where n.assignment_id = a.id)
       and not exists (select 1 from notifications n where n.assignment_id = a.id and n.status in ('pending', 'sending', 'retrying'))
     limit ${limit}`.execute(db);
  return rows.map((row) => ({ assignmentId: row.id, leadId: row.lead_id }));
}

export async function unprocessedEvents(db: Database, limit: number): Promise<Array<{ id: number; providerMessageId: string; status: string; errorCode: string | null }>> {
  const { rows } = await sql<{ id: string; provider_message_id: string; status: string; error_code: string | null }>`
    select id, provider_message_id, status, error_code from provider_events
     where processed_at is null and provider_message_id is not null and received_at < now() - interval '2 seconds' and received_at > now() - interval '2 days'
     order by id limit ${limit}`.execute(db);
  return rows.map((row) => ({ id: Number(row.id), providerMessageId: row.provider_message_id, status: row.status, errorCode: row.error_code }));
}

export async function setDelivered(db: Database, id: string): Promise<boolean> {
  return updated(await db.updateTable("notifications").set({ status: "delivered", delivered_at: sql<Date>`now()` }).where("id", "=", id).where("status", "=", "sent").executeTakeFirst());
}
export async function setUndelivered(db: Database, id: string, errorCode: string): Promise<boolean> {
  return updated(await db.updateTable("notifications").set({ status: "failed", last_error_code: errorCode }).where("id", "=", id).where("status", "=", "sent").executeTakeFirst());
}

// ------------------------------------------------------------------------------------------------
// Health
// ------------------------------------------------------------------------------------------------

export type DeliveryProblem = "deliveries_overdue" | "deliveries_failing" | "deliveries_missing";
export interface DeliveryHealth {
  ok: boolean;
  problems: DeliveryProblem[];
}

/** Counts only (it feeds a public endpoint). "Failing" clears when a person retries it, takes the lead back, or the failure ages out. */
export async function getDeliveryHealth(db: Database): Promise<DeliveryHealth> {
  const { rows } = await sql<{ overdue: boolean; failing: boolean; missing: boolean }>`
    select exists (select 1 from notifications where (status in ('pending', 'retrying') and next_attempt_at < now() - make_interval(secs => ${DELIVERY_POLICY.overdueSeconds}))
                       or (status = 'sending' and locked_until < now() - make_interval(secs => ${DELIVERY_POLICY.overdueSeconds}))) as overdue,
           exists (select 1 from notifications n join lead_assignments a on a.id = n.assignment_id
                    where n.status in ('failed', 'dead') and a.status in ('reserved', 'notified') and n.updated_at > now() - make_interval(hours => ${DELIVERY_POLICY.lookbackHours})) as failing,
           exists (select 1 from lead_assignments a join clients c on c.id = a.client_id
                    where a.status = 'reserved' and c.delivery_mode = 'automatic' and a.created_at >= c.delivery_enabled_at
                      and a.created_at < now() - make_interval(secs => ${DELIVERY_POLICY.overdueSeconds}) and a.created_at > now() - make_interval(hours => ${DELIVERY_POLICY.lookbackHours})
                      and not exists (select 1 from notifications n where n.assignment_id = a.id)) as missing`.execute(db);
  const row = rows[0]!;
  const problems: DeliveryProblem[] = [];
  if (row.overdue) problems.push("deliveries_overdue");
  if (row.failing) problems.push("deliveries_failing");
  if (row.missing) problems.push("deliveries_missing");
  return { ok: problems.length === 0, problems };
}

