import { sql } from "kysely";
import { HELD_STATUSES } from "@/config/client-dashboard";
import type { Database } from "@/lib/db/client";
import type { UrgencyLevel } from "@/lib/db/schema";
import type { ContactOutcome } from "@/config/client-dashboard";
import { describeRule, type CoverageKind } from "@/modules/clients/schemas";

/**
 * All SQL for what a business sees (stage 6). Every function takes a database handle that is ALREADY scoped to one business
 * (`withClientScope`) AND repeats `client_id = $1` itself: two independent layers, so forgetting one is caught by the other (D45).
 */

type AssignmentStatusName = "reserved" | "notified" | "accepted" | "disputed" | "rejected" | "refunded" | "expired" | "cancelled" | "delivery_failed";

export interface LeadRow {
  assignmentId: string;
  reference: string;
  serviceLabel: string;
  urgency: UrgencyLevel;
  /** The outward part only: the full postcode is shown on the detail page, and only while the lead is held. */
  district: string;
  status: AssignmentStatusName;
  assignedAt: Date;
  notifiedAt: Date | null;
}

/**
 * What a business has been told about. A lead we could not deliver (`delivery_failed`), or one taken back before the business was ever
 * told (cancelled or expired with no `notified_at`), was never really theirs and would only confuse: it is not listed.
 */
const VISIBLE = sql`(a.status in ('reserved', 'notified', 'accepted', 'disputed', 'rejected', 'refunded')
                     or (a.status in ('cancelled', 'expired') and a.notified_at is not null))`;
const HELD = sql.join(HELD_STATUSES.map((status) => sql.lit(status)));

export async function listLeads(db: Database, clientId: string, input: { view: "open" | "history"; limit: number }): Promise<{ rows: LeadRow[]; more: boolean }> {
  const { rows } = await sql<{
    assignment_id: string; reference: string; service_label: string; urgency: UrgencyLevel; district: string; status: AssignmentStatusName; created_at: Date; notified_at: Date | null;
  }>`
    select a.id as assignment_id, l.reference, st.label as service_label, l.urgency, l.postcode_outward as district, a.status, a.created_at, a.notified_at
      from lead_assignments a
      join leads l on l.id = a.lead_id
      join service_types st on st.id = l.service_type_id
     where a.client_id = ${clientId} and ${VISIBLE}
       and ${input.view === "open" ? sql`a.status::text in (${HELD})` : sql`a.status::text not in (${HELD})`}
     order by a.created_at desc, a.id desc
     limit ${input.limit + 1}`.execute(db);
  return {
    rows: rows.slice(0, input.limit).map((r) => ({ assignmentId: r.assignment_id, reference: r.reference, serviceLabel: r.service_label, urgency: r.urgency, district: r.district, status: r.status, assignedAt: r.created_at, notifiedAt: r.notified_at })),
    more: rows.length > input.limit,
  };
}

export interface LeadDetailRow {
  assignmentId: string;
  reference: string;
  serviceLabel: string;
  urgency: UrgencyLevel;
  propertyType: string;
  ownership: string;
  scope: string | null;
  district: string;
  /** Only while held; never for a lead whose personal data was erased. */
  postcode: string | null;
  status: AssignmentStatusName;
  assignedAt: Date;
  notifiedAt: Date | null;
  contact: { name: string; phone: string; email: string; notes: string | null } | null;
  /** Why there is no contact: it is not (or no longer) theirs, or the person has asked for it to be erased. */
  contactState: "visible" | "not_held" | "erased";
  /** What they did with it, newest first. */
  attempts: ContactAttemptRow[];
}

export interface ContactAttemptRow {
  id: string;
  outcome: ContactOutcome;
  note: string | null;
  jobValuePence: number | null;
  occurredAt: Date;
  by: string | null;
}

export async function getLeadDetail(db: Database, clientId: string, assignmentId: string): Promise<Omit<LeadDetailRow, "attempts"> | undefined> {
  const { rows } = await sql<{
    assignment_id: string; reference: string; service_label: string; urgency: UrgencyLevel; property_type: string; ownership: string; details: { scope?: string } | null;
    district: string; postcode: string | null; status: AssignmentStatusName; created_at: Date; notified_at: Date | null; lead_erased: boolean;
    full_name: string | null; phone_e164: string | null; email: string | null; notes: string | null; contact_erased: Date | null;
  }>`
    select a.id as assignment_id, l.reference, st.label as service_label, l.urgency, l.property_type, l.ownership, l.details,
           l.postcode_outward as district, l.postcode, a.status, a.created_at, a.notified_at, (l.erased_at is not null) as lead_erased,
           lc.full_name, lc.phone_e164, lc.email, lc.notes, lc.erased_at as contact_erased
      from lead_assignments a
      join leads l on l.id = a.lead_id
      join service_types st on st.id = l.service_type_id
      left join lead_contacts lc on lc.lead_id = l.id
     where a.id = ${assignmentId} and a.client_id = ${clientId} and ${VISIBLE}`.execute(db);
  const row = rows[0];
  if (!row) return undefined;
  const held = (HELD_STATUSES as readonly string[]).includes(row.status);
  const erased = row.lead_erased || row.contact_erased !== null;
  const hasDetails = held && !erased && row.full_name !== null && row.phone_e164 !== null && row.email !== null;
  return {
    assignmentId: row.assignment_id, reference: row.reference, serviceLabel: row.service_label, urgency: row.urgency, propertyType: row.property_type, ownership: row.ownership,
    scope: row.details?.scope ?? null, district: row.district,
    postcode: held && !erased ? row.postcode : null,
    status: row.status, assignedAt: row.created_at, notifiedAt: row.notified_at,
    contact: hasDetails ? { name: row.full_name!, phone: row.phone_e164!, email: row.email!, notes: row.notes } : null,
    contactState: hasDetails ? "visible" : erased ? "erased" : "not_held",
  };
}


export async function listContactAttempts(db: Database, clientId: string, assignmentId: string): Promise<ContactAttemptRow[]> {
  const { rows } = await sql<{ id: string; outcome: ContactOutcome; note: string | null; job_value_pence: number | null; occurred_at: Date; by: string | null }>`
    select t.id, t.outcome, t.note, t.job_value_pence, t.occurred_at, u.name as by
      from assignment_contact_attempts t
      join lead_assignments a on a.id = t.assignment_id
      left join client_users u on u.id = t.created_by
     where t.assignment_id = ${assignmentId} and a.client_id = ${clientId}
     order by t.occurred_at desc, t.id desc`.execute(db);
  return rows.map((r) => ({ id: r.id, outcome: r.outcome, note: r.note, jobValuePence: r.job_value_pence, occurredAt: r.occurred_at, by: r.by }));
}

/** What state the business's own assignment is in, locked, so the answer to "may it log a call?" cannot change under us. */
export async function lockOwnAssignmentStatus(db: Database, clientId: string, assignmentId: string): Promise<AssignmentStatusName | undefined> {
  const { rows } = await sql<{ status: AssignmentStatusName }>`select status from lead_assignments where id = ${assignmentId} and client_id = ${clientId} for update`.execute(db);
  return rows[0]?.status;
}

export async function insertContactAttempt(db: Database, input: { assignmentId: string; outcome: ContactOutcome; note: string | null; jobValuePence: number | null; createdBy: string }): Promise<void> {
  await sql`insert into assignment_contact_attempts (assignment_id, outcome, note, job_value_pence, created_by)
            values (${input.assignmentId}, ${input.outcome}::contact_outcome, ${input.note}, ${input.jobValuePence}, ${input.createdBy})`.execute(db);
}

// ------------------------------------------------------------------------------------------------
// Notification settings, areas, change requests, performance (slice 5)
// ------------------------------------------------------------------------------------------------

export interface NotificationState {
  mode: "manual" | "automatic";
  email: boolean;
  sms: boolean;
  /** Set up by staff (it needs a signing secret): the business sees that it is on but cannot change it. */
  webhook: boolean;
  contactEmail: string;
  contactPhone: string | null;
  contactName: string | null;
}

export async function getNotificationState(db: Database, clientId: string): Promise<NotificationState | undefined> {
  const { rows } = await sql<{ delivery_mode: "manual" | "automatic"; notify_email: boolean; notify_sms: boolean; notify_webhook: boolean; contact_email: string; contact_phone_e164: string | null; contact_name: string | null }>`
    select delivery_mode, notify_email, notify_sms, notify_webhook, contact_email, contact_phone_e164, contact_name from clients where id = ${clientId} and deleted_at is null for update`.execute(db);
  const r = rows[0];
  return r && { mode: r.delivery_mode, email: r.notify_email, sms: r.notify_sms, webhook: r.notify_webhook, contactEmail: r.contact_email, contactPhone: r.contact_phone_e164, contactName: r.contact_name };
}

/** Exactly these columns and no others: a business cannot reach anything else of its own record from here. */
export async function updateNotificationState(db: Database, clientId: string, input: { email: boolean; sms: boolean; contactEmail: string; contactPhone: string | null }): Promise<void> {
  await sql`update clients set notify_email = ${input.email}, notify_sms = ${input.sms}, contact_email = ${input.contactEmail}, contact_phone_e164 = ${input.contactPhone} where id = ${clientId}`.execute(db);
}

export interface ServiceAreaView {
  services: string[];
  rules: Array<{ mode: "include" | "exclude"; description: string }>;
}

export async function getServiceAreaView(db: Database, clientId: string): Promise<ServiceAreaView> {
  const [services, rules] = await Promise.all([
    sql<{ label: string }>`select st.label from client_services cs join service_types st on st.id = cs.service_type_id where cs.client_id = ${clientId} order by st.label`.execute(db),
    sql<{ mode: "include" | "exclude"; kind: CoverageKind; outward: string | null; sector: string | null; postcode_prefix: string | null; center_postcode: string | null; radius_m: number | null; area_name: string | null }>`
      select r.mode, r.kind, r.outward, r.sector, r.postcode_prefix, r.center_postcode, r.radius_m, sa.name as area_name
        from client_service_areas r left join service_areas sa on sa.id = r.service_area_id
       where r.client_id = ${clientId} and r.active order by r.mode, r.kind, r.outward, r.sector, r.postcode_prefix`.execute(db),
  ]);
  return {
    services: services.rows.map((r) => r.label),
    rules: rules.rows.map((r) => ({ mode: r.mode, description: describeRule({ kind: r.kind, outward: r.outward, sector: r.sector, postcode_prefix: r.postcode_prefix, center_postcode: r.center_postcode, radius_m: r.radius_m }, r.area_name) })),
  };
}

export interface ChangeRequestRow {
  id: string;
  kind: "coverage" | "services" | "other";
  message: string;
  status: "open" | "done";
  createdAt: Date;
  doneAt: Date | null;
  clientId: string;
  clientName: string;
  requestedBy: string;
}

type RawRequest = { id: string; kind: ChangeRequestRow["kind"]; message: string; status: ChangeRequestRow["status"]; created_at: Date; done_at: Date | null; client_id: string; client_name: string; requested_by: string };
const toRequest = (r: RawRequest): ChangeRequestRow => ({ id: r.id, kind: r.kind, message: r.message, status: r.status, createdAt: r.created_at, doneAt: r.done_at, clientId: r.client_id, clientName: r.client_name, requestedBy: r.requested_by });

export async function listChangeRequests(db: Database, clientId: string, limit: number): Promise<ChangeRequestRow[]> {
  const { rows } = await sql<RawRequest>`
    select r.id, r.kind, r.message, r.status, r.created_at, r.done_at, r.client_id, c.name as client_name, u.name as requested_by
      from client_change_requests r join clients c on c.id = r.client_id join client_users u on u.id = r.requested_by
     where r.client_id = ${clientId} order by r.created_at desc limit ${limit}`.execute(db);
  return rows.map(toRequest);
}

export async function countOpenChangeRequestsFor(db: Database, clientId: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*) as n from client_change_requests where client_id = ${clientId} and status = 'open'`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

export async function insertChangeRequest(db: Database, input: { clientId: string; kind: "coverage" | "services" | "other"; message: string; requestedBy: string }): Promise<string> {
  const { rows } = await sql<{ id: string }>`insert into client_change_requests (client_id, kind, message, requested_by) values (${input.clientId}, ${input.kind}::change_request_kind, ${input.message}, ${input.requestedBy}) returning id`.execute(db);
  return rows[0]!.id;
}

/** Staff: every open request, oldest first; for a client page; and marking one done. */
export async function listOpenChangeRequests(db: Database, clientId?: string): Promise<ChangeRequestRow[]> {
  const { rows } = await sql<RawRequest>`
    select r.id, r.kind, r.message, r.status, r.created_at, r.done_at, r.client_id, c.name as client_name, u.name as requested_by
      from client_change_requests r join clients c on c.id = r.client_id join client_users u on u.id = r.requested_by
     where r.status = 'open' ${clientId ? sql`and r.client_id = ${clientId}` : sql``} order by r.created_at asc limit 200`.execute(db);
  return rows.map(toRequest);
}

export async function markChangeRequestDone(db: Database, requestId: string, operatorId: string): Promise<{ clientId: string } | undefined> {
  const { rows } = await sql<{ client_id: string }>`update client_change_requests set status = 'done', done_by = ${operatorId}, done_at = now() where id = ${requestId} and status = 'open' returning client_id`.execute(db);
  return rows[0] && { clientId: rows[0].client_id };
}

export async function countOpenChangeRequests(db: Database): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*) as n from client_change_requests where status = 'open'`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

export interface PerformanceRow {
  days: number;
  received: number;
  accepted: number;
  declined: number;
  contacted: number;
  reached: number;
  quoted: number;
  won: number;
  refunded: number;
  /** Median minutes from being told to accepting or declining; null when nothing was answered. */
  medianResponseMinutes: number | null;
  /** Median minutes from accepting to the first recorded contact. */
  medianFirstContactMinutes: number | null;
  wonValuePence: number;
  spendPence: number;
}

/** Counts derived from the same tables as everything else (no separate analytics store). A lead counts in the window its assignment was created in. */
export async function getPerformance(db: Database, clientId: string, days: number): Promise<PerformanceRow> {
  const { rows } = await sql<Record<string, string | null>>`
    with w as (
      select a.* from lead_assignments a
       where a.client_id = ${clientId} and ${VISIBLE} and a.created_at >= now() - make_interval(days => ${days})
    ), first_contact as (
      select t.assignment_id, min(t.occurred_at) as at from assignment_contact_attempts t join w on w.id = t.assignment_id group by t.assignment_id
    )
    select
      (select count(*) from w) as received,
      (select count(*) from w where accepted_at is not null) as accepted,
      (select count(*) from w where status = 'rejected') as declined,
      (select count(*) from w where exists (select 1 from assignment_contact_attempts t where t.assignment_id = w.id)) as contacted,
      (select count(*) from w where exists (select 1 from assignment_contact_attempts t where t.assignment_id = w.id and t.outcome in ('spoke', 'quote_sent', 'won', 'lost', 'not_interested'))) as reached,
      (select count(*) from w where exists (select 1 from assignment_contact_attempts t where t.assignment_id = w.id and t.outcome in ('quote_sent', 'won'))) as quoted,
      (select count(*) from w where exists (select 1 from assignment_contact_attempts t where t.assignment_id = w.id and t.outcome = 'won')) as won,
      (select count(*) from w where status = 'refunded') as refunded,
      (select percentile_cont(0.5) within group (order by extract(epoch from (coalesce(w.accepted_at, w.rejected_at) - w.notified_at)) / 60)
         from w where w.notified_at is not null and coalesce(w.accepted_at, w.rejected_at) is not null) as median_response,
      (select percentile_cont(0.5) within group (order by extract(epoch from (f.at - w.accepted_at)) / 60)
         from w join first_contact f on f.assignment_id = w.id where w.accepted_at is not null and f.at >= w.accepted_at) as median_first_contact,
      coalesce((select sum((select max(t.job_value_pence) from assignment_contact_attempts t where t.assignment_id = w.id and t.outcome = 'won')) from w), 0) as won_value,
      coalesce((select sum(c.amount_pence) from lead_charges c join w on w.id = c.assignment_id where c.status = 'posted'), 0) as spend`.execute(db);
  const r = rows[0]!;
  const n = (value: string | null | undefined) => Number(value ?? 0);
  const m = (value: string | null | undefined) => (value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10);
  return {
    days, received: n(r.received), accepted: n(r.accepted), declined: n(r.declined), contacted: n(r.contacted), reached: n(r.reached), quoted: n(r.quoted), won: n(r.won), refunded: n(r.refunded),
    medianResponseMinutes: m(r.median_response), medianFirstContactMinutes: m(r.median_first_contact), wonValuePence: n(r.won_value), spendPence: n(r.spend),
  };
}
