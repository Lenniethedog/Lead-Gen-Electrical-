import { sql } from "kysely";
import { LEAD_EVENT } from "@/config/lead-events";
import type { Database } from "@/lib/db/client";
import { handledByAPerson, hasUnsentAssignment, needsAPerson } from "@/lib/db/lead-predicates";
import type { LeadStatus } from "@/lib/db/schema";
import type { InboxRow, InboxView, LeadDetail, Operator, TimelineEntry } from "./types";

/** All SQL for the operator inbox. Takes a `Database` (possibly a transaction); the service owns transactions. */

// ------------------------------------------------------------------------------------------------
// Operators (the people behind Cloudflare Access)
// ------------------------------------------------------------------------------------------------

/** First sight of an email creates the row; concurrent first requests converge on one row. The role comes from configuration. */
export async function ensureOperator(db: Database, email: string, role: Operator["role"] = "staff"): Promise<Operator> {
  await db
    .insertInto("operators")
    .values({ email })
    .onConflict((conflict) => conflict.column("email").doNothing())
    .execute();
  const row = await db.selectFrom("operators").select(["id", "email"]).where("email", "=", email).executeTakeFirstOrThrow();
  return { ...row, role };
}

// ------------------------------------------------------------------------------------------------
// Reading
// ------------------------------------------------------------------------------------------------

const HANDLED = handledByAPerson;

const VIEW_PREDICATE: Record<InboxView, ReturnType<typeof sql<boolean>>> = {
  // Needs a person: held (decide); new or unroutable and nobody has dealt with it; or assigned (by hand or by the router) and not yet SENT
  // to the business. The same definition drives the reminder email and the health check (src/lib/db/lead-predicates.ts).
  open: needsAPerson,
  handled: sql<boolean>`(l.status in ('new', 'unroutable') and ${HANDLED})`,
  // Handed to a business: the lead page shows which one (includes those still to be sent, which are ALSO in "Needs action").
  assigned: sql<boolean>`(l.status = 'assigned')`,
  // What the screen rejected or merged: visible so false positives can be noticed and tuned.
  screened: sql<boolean>`(l.status in ('rejected_fraud', 'duplicate'))`,
};

interface RowShape {
  id: string;
  reference: string;
  created_at: Date;
  status: LeadStatus;
  service_label: string;
  postcode_outward: string;
  urgency: InboxRow["urgency"];
  fraud_score: number;
  fraud_decision: InboxRow["fraudDecision"];
  handled: boolean;
  unsent: boolean;
  alert_status: InboxRow["alert"] | null;
}

const toRow = (row: RowShape): InboxRow => ({
  id: row.id,
  reference: row.reference,
  receivedAt: row.created_at,
  status: row.status,
  serviceLabel: row.service_label,
  postcodeOutward: row.postcode_outward,
  urgency: row.urgency,
  fraudScore: row.fraud_score,
  fraudDecision: row.fraud_decision,
  handled: row.handled,
  unsent: row.unsent,
  alert: row.alert_status ?? "none",
});

const ROW_COLUMNS = sql`
  l.id, l.reference, l.created_at, l.status, s.label as service_label, l.postcode_outward, l.urgency,
  l.fraud_score, l.fraud_decision, ${HANDLED} as handled, (l.status = 'assigned' and ${hasUnsentAssignment}) as unsent,
  (select a.status from operator_alerts a where a.lead_id = l.id and a.kind in ('new_lead', 'held_lead')) as alert_status`;

export const INBOX_PAGE_SIZE = 200;

/**
 * Newest first, always: when a view is longer than the page, it is the OLDEST rows that are cut off,
 * never a lead that has just arrived (the one the operator was alerted about). The caller is told the
 * true total so the page can say how many are not shown.
 *
 * No personal data in a list row: contact details are only ever read for one lead at a time, on its own page.
 */
export async function listLeads(db: Database, view: InboxView): Promise<InboxRow[]> {
  const { rows } = await sql<RowShape>`
    select ${ROW_COLUMNS}
      from leads l join service_types s on s.id = l.service_type_id
     where l.deleted_at is null and not l.is_test and ${VIEW_PREDICATE[view]}
     order by l.created_at desc
     limit ${INBOX_PAGE_SIZE}`.execute(db);
  return rows.map(toRow);
}

export async function countView(db: Database, view: InboxView): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from leads l
     where l.deleted_at is null and not l.is_test and ${VIEW_PREDICATE[view]}`.execute(db);
  return rows[0]?.n ?? 0;
}

const STATUS_TEXT: Record<string, string> = {
  new: "Ready for a human",
  held: "Held for review",
  routing: "Being routed",
  unroutable: "Nobody could take it automatically",
  assigned: "Assigned to a business",
  rejected_fraud: "Rejected by screening or a reviewer",
  duplicate: "Marked as a duplicate",
  invalid: "Marked invalid",
  expired: "Expired",
};

function describeEvent(type: string, payload: Record<string, unknown>): string {
  switch (type) {
    case "lead.received":
      return `Received from ${String(payload.source ?? "unknown source")}`;
    case "lead.screened":
      return `Screened: score ${String(payload.score ?? "?")}, ${String(payload.decision ?? "?")}${
        Array.isArray(payload.signals) && payload.signals.length > 0 ? ` (${payload.signals.join(", ")})` : ""
      }`;
    case "lead.duplicate_detected":
      return "Duplicate of an earlier enquiry detected";
    case LEAD_EVENT.handled:
      return "Marked as handled";
    case LEAD_EVENT.reviewApproved:
      return `Held lead approved (${String(payload.reason ?? "no reason")})`;
    case LEAD_EVENT.reviewRejected:
      return `Held lead rejected (${String(payload.reason ?? "no reason")})`;
    case LEAD_EVENT.routed:
      return "Routed automatically to a business";
    case LEAD_EVENT.unroutable:
      return `Automatic routing found nobody (${String(payload.reason ?? "no reason")}). It is waiting for a person.`;
    case LEAD_EVENT.deliveryFailed:
      return "Delivery to the business failed on every way it was tried: the assignment ended and the lead is free again";
    case LEAD_EVENT.routingStopped:
      return `Taken back for a reason that needs a person (${String(payload.reason ?? "no reason")}): it will not be routed automatically`;
    default:
      return type;
  }
}

export async function getLeadDetail(db: Database, leadId: string): Promise<LeadDetail | undefined> {
  const { rows } = await sql<RowShape & { postcode: string | null; property_type: string; ownership: string; details: { scope?: string }; duplicate_of: string | null }>`
    select ${ROW_COLUMNS}, l.postcode, l.property_type, l.ownership, l.details,
           (select o.reference from leads o where o.id = l.duplicate_of_lead_id) as duplicate_of
      from leads l join service_types s on s.id = l.service_type_id
     where l.id = ${leadId} and l.deleted_at is null`.execute(db);
  const lead = rows[0];
  if (!lead) return undefined;

  const [contact, consent, withdrawal, attribution, signals, alerts, events, history] = await Promise.all([
    db.selectFrom("lead_contacts").select(["full_name", "phone_e164", "email", "notes", "erased_at"]).where("lead_id", "=", leadId).executeTakeFirst(),
    db
      .selectFrom("consent_records as c")
      .innerJoin("consent_texts as t", "t.id", "c.consent_text_id")
      .select(["t.version", "c.captured_at"])
      .where("c.lead_id", "=", leadId)
      .where("c.event", "=", "granted")
      .orderBy("c.captured_at", "asc")
      .executeTakeFirst(),
    db.selectFrom("consent_records").select("captured_at").where("lead_id", "=", leadId).where("event", "=", "withdrawn").orderBy("captured_at").limit(1).executeTakeFirst(),
    db.selectFrom("lead_attributions").select(["utm_source", "utm_medium", "utm_campaign", "landing_path"]).where("lead_id", "=", leadId).executeTakeFirst(),
    db.selectFrom("lead_fraud_signals").select(["code", "weight"]).where("lead_id", "=", leadId).orderBy("weight", "desc").execute(),
    db.selectFrom("operator_alerts").select(["kind", "status", "attempt_count", "sent_at", "last_error_code"]).where("lead_id", "=", leadId).orderBy("created_at").execute(),
    db
      .selectFrom("lead_events as e")
      .leftJoin("operators as o", (join) => join.onRef("o.id", "=", "e.actor_id").on("e.actor_type", "=", "staff_user"))
      .select(["e.type", "e.actor_type", "e.payload", "e.created_at", "o.email as operator_email"])
      .where("e.lead_id", "=", leadId)
      .orderBy("e.id")
      .execute(),
    db
      .selectFrom("lead_status_history as h")
      .leftJoin("operators as o", (join) => join.onRef("o.id", "=", "h.actor_id").on("h.actor_type", "=", "staff_user"))
      .select(["h.from_status", "h.to_status", "h.actor_type", "h.reason", "h.created_at", "o.email as operator_email"])
      .where("h.lead_id", "=", leadId)
      .orderBy("h.id")
      .execute(),
  ]);

  const timeline: TimelineEntry[] = [
    ...events.map((event) => ({
      at: event.created_at,
      source: "event" as const,
      text: describeEvent(event.type, event.payload as Record<string, unknown>),
      actor: event.operator_email ?? event.actor_type,
    })),
    ...history.map((change) => ({
      at: change.created_at,
      source: "status" as const,
      text: change.from_status
        ? `Status ${change.from_status} -> ${change.to_status}${change.reason ? ` (${change.reason})` : ""}`
        : `Created as ${change.to_status}: ${STATUS_TEXT[change.to_status] ?? change.to_status}`,
      actor: change.operator_email ?? change.actor_type,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const erased = !contact || contact.erased_at !== null || contact.full_name === null;
  return {
    ...toRow(lead),
    postcode: lead.postcode,
    propertyType: lead.property_type,
    ownership: lead.ownership,
    scope: lead.details?.scope ?? null,
    contact: erased
      ? null
      : { name: contact.full_name!, phone: contact.phone_e164!, email: contact.email!, notes: contact.notes },
    consent: consent ? { version: consent.version, capturedAt: consent.captured_at, withdrawnAt: withdrawal?.captured_at ?? null } : null,
    erased,
    attribution: attribution
      ? { source: attribution.utm_source, medium: attribution.utm_medium, campaign: attribution.utm_campaign, landingPath: attribution.landing_path }
      : null,
    signals,
    alerts: alerts.map((alert) => ({ kind: alert.kind, status: alert.status, attempts: alert.attempt_count, sentAt: alert.sent_at, errorCode: alert.last_error_code })),
    timeline,
    duplicateOfReference: lead.duplicate_of,
  };
}

// ------------------------------------------------------------------------------------------------
// Writing (all inside a transaction opened by the service)
// ------------------------------------------------------------------------------------------------

// The transaction-local staff context lives in src/lib/db/audit-context.ts (shared with assignments and privacy).
export { setStaffContext } from "@/lib/db/audit-context";

/**
 * Compare-and-set on the current status: of any number of simultaneous decisions on the same lead,
 * exactly one finds it still `held`. Returns false for the rest.
 */
export async function transitionHeldLead(db: Database, leadId: string, to: Extract<LeadStatus, "new" | "rejected_fraud">): Promise<boolean> {
  const row = await db
    .updateTable("leads")
    .set({ status: to })
    .where("id", "=", leadId)
    .where("status", "=", "held")
    .where("deleted_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

export async function insertOperatorEvent(
  db: Database,
  input: { leadId: string; operatorId: string; requestId: string; type: string; payload?: Record<string, unknown> },
): Promise<void> {
  await db
    .insertInto("lead_events")
    .values({
      lead_id: input.leadId,
      type: input.type,
      actor_type: "staff_user",
      actor_id: input.operatorId,
      request_id: input.requestId,
      payload: JSON.stringify(input.payload ?? {}),
    })
    .execute();
}

/** Locks the lead row so concurrent operator actions on one lead are serialised; returns its status. */
export async function lockLeadStatus(db: Database, leadId: string): Promise<LeadStatus | undefined> {
  const row = await db.selectFrom("leads").select("status").where("id", "=", leadId).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
  return row?.status;
}

export async function leadStatus(db: Database, leadId: string): Promise<LeadStatus | undefined> {
  const row = await db.selectFrom("leads").select("status").where("id", "=", leadId).where("deleted_at", "is", null).executeTakeFirst();
  return row?.status;
}

export async function isHandled(db: Database, leadId: string): Promise<boolean> {
  const { rows } = await sql<{ handled: boolean }>`
    select exists (select 1 from lead_events e where e.lead_id = ${leadId} and e.type = ${LEAD_EVENT.handled}) as handled`.execute(db);
  return rows[0]?.handled ?? false;
}
