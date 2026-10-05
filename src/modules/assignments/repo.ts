import { sql } from "kysely";
import type { Database } from "@/lib/db/client";
import type { LeadStatus, UrgencyLevel } from "@/lib/db/schema";

/** All SQL for assignments. Takes a `Database` (possibly a transaction); the service owns transaction boundaries. */

export type AssignmentStatus = "reserved" | "notified" | "accepted" | "disputed" | "rejected" | "refunded" | "expired" | "cancelled" | "delivery_failed";
export const ACTIVE_STATUSES: readonly AssignmentStatus[] = ["reserved", "notified", "accepted", "disputed"];

export interface LeadForAssignment {
  id: string;
  reference: string;
  status: LeadStatus;
  /** Full postcode: null once erased. */
  postcode: string | null;
  postcodeOutward: string;
  verticalId: number;
  serviceTypeId: number;
  urgency: UrgencyLevel;
  saleModel: "exclusive" | "shared" | null;
  erased: boolean;
  deleted: boolean;
}

/** Locks the lead row for the rest of the transaction: concurrent assign / cancel / reassign / erase on one lead queue up here. */
export async function lockLead(db: Database, leadId: string): Promise<LeadForAssignment | undefined> {
  const row = await db
    .selectFrom("leads")
    .select(["id", "reference", "status", "postcode", "postcode_outward", "vertical_id", "service_type_id", "urgency", "sale_model", "erased_at", "deleted_at"])
    .where("id", "=", leadId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: row.id,
    reference: row.reference,
    status: row.status,
    postcode: row.postcode,
    postcodeOutward: row.postcode_outward,
    verticalId: row.vertical_id,
    serviceTypeId: row.service_type_id,
    urgency: row.urgency,
    saleModel: row.sale_model,
    erased: row.erased_at !== null,
    deleted: row.deleted_at !== null,
  };
}

export async function consentState(db: Database, leadId: string): Promise<{ maxRecipients: number | null; withdrawn: boolean }> {
  const { rows } = await sql<{ max_recipients: number | null; withdrawn: boolean }>`
    select consent_max_recipients(${leadId}) as max_recipients,
           exists (select 1 from consent_records r where r.lead_id = ${leadId} and r.event = 'withdrawn') as withdrawn`.execute(db);
  return { maxRecipients: rows[0]?.max_recipients ?? null, withdrawn: rows[0]?.withdrawn ?? false };
}

/** The first assignment commits the lead to the exclusive model with a cap of one (the only model stage 3 sells). */
export async function commitExclusive(db: Database, leadId: string): Promise<void> {
  await sql`update leads set sale_model = 'exclusive' where id = ${leadId} and sale_model is null`.execute(db);
}

export interface AssignmentRow {
  id: string;
  leadId: string;
  clientId: string;
  status: AssignmentStatus;
  pricePence: number;
  pricingRuleId: string | null;
  notifiedAt: Date | null;
  createdAt: Date;
}

const ASSIGNMENT_COLUMNS = ["id", "lead_id", "client_id", "status", "price_pence", "pricing_rule_id", "notified_at", "created_at"] as const;
const toAssignment = (row: { id: string; lead_id: string; client_id: string; status: AssignmentStatus; price_pence: number; pricing_rule_id: string | null; notified_at: Date | null; created_at: Date }): AssignmentRow => ({
  id: row.id, leadId: row.lead_id, clientId: row.client_id, status: row.status, pricePence: row.price_pence, pricingRuleId: row.pricing_rule_id, notifiedAt: row.notified_at, createdAt: row.created_at,
});

export async function getAssignment(db: Database, id: string): Promise<AssignmentRow | undefined> {
  const row = await db.selectFrom("lead_assignments").select(ASSIGNMENT_COLUMNS).where("id", "=", id).executeTakeFirst();
  return row ? toAssignment(row) : undefined;
}

export async function lockAssignment(db: Database, id: string): Promise<AssignmentRow | undefined> {
  const row = await db.selectFrom("lead_assignments").select(ASSIGNMENT_COLUMNS).where("id", "=", id).forUpdate().executeTakeFirst();
  return row ? toAssignment(row) : undefined;
}

export async function activeAssignmentsForLead(db: Database, leadId: string): Promise<AssignmentRow[]> {
  const rows = await db.selectFrom("lead_assignments").select(ASSIGNMENT_COLUMNS).where("lead_id", "=", leadId).where("status", "in", [...ACTIVE_STATUSES]).orderBy("created_at").execute();
  return rows.map(toAssignment);
}

export async function insertAssignment(
  db: Database,
  input: { leadId: string; clientId: string; operatorId: string; pricePence: number; pricingRuleId: string | null },
): Promise<string> {
  const row = await db
    .insertInto("lead_assignments")
    .values({
      lead_id: input.leadId,
      client_id: input.clientId,
      sale_type: "exclusive",
      status: "reserved",
      assigned_by: "staff",
      assigned_by_user_id: input.operatorId,
      price_pence: input.pricePence,
      pricing_rule_id: input.pricingRuleId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** A timeline entry for the lead, made by a person. Ids and codes only: never personal data. */
export async function insertLeadEvent(
  db: Database,
  input: { leadId: string; type: string; operatorId: string; requestId: string; payload: Record<string, unknown> },
): Promise<void> {
  await db
    .insertInto("lead_events")
    .values({ lead_id: input.leadId, type: input.type, actor_type: "staff_user", actor_id: input.operatorId, request_id: input.requestId, payload: JSON.stringify(input.payload) })
    .execute();
}

/** An automatic assignment (stage 4): made by the router, explained by a routing run, attributed to nobody. */
export async function insertRoutedAssignment(
  db: Database,
  input: { leadId: string; clientId: string; routingRunId: string; pricePence: number; pricingRuleId: string | null },
): Promise<string> {
  const row = await db
    .insertInto("lead_assignments")
    .values({
      lead_id: input.leadId,
      client_id: input.clientId,
      sale_type: "exclusive",
      status: "reserved",
      assigned_by: "router",
      routing_run_id: input.routingRunId,
      price_pence: input.pricePence,
      pricing_rule_id: input.pricingRuleId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Compare-and-set on the assignment's current status. */
export async function transitionAssignment(
  db: Database,
  id: string,
  from: AssignmentStatus,
  to: AssignmentStatus,
): Promise<boolean> {
  const row = await db
    .updateTable("lead_assignments")
    .set({ status: to, ...(to === "notified" && { notified_at: sql<Date>`now()` }) })
    .where("id", "=", id)
    .where("status", "=", from)
    .returning("id")
    .executeTakeFirst();
  return row !== undefined;
}

/** Compare-and-set on the lead's status (the history trigger records who, from the transaction context). */
export async function transitionLead(db: Database, leadId: string, from: LeadStatus, to: LeadStatus): Promise<boolean> {
  const row = await db.updateTable("leads").set({ status: to }).where("id", "=", leadId).where("status", "=", from).returning("id").executeTakeFirst();
  return row !== undefined;
}

export interface AssignmentHistoryEntry {
  at: Date;
  from: AssignmentStatus | null;
  to: AssignmentStatus;
  actor: string;
  reason: string | null;
}

export interface LeadAssignmentView extends AssignmentRow {
  clientName: string;
  clientContactName: string | null;
  clientContactEmail: string;
  clientContactPhone: string | null;
  active: boolean;
  history: AssignmentHistoryEntry[];
}

export async function assignmentsForLead(db: Database, leadId: string): Promise<LeadAssignmentView[]> {
  const rows = await db
    .selectFrom("lead_assignments as a")
    .innerJoin("clients as c", "c.id", "a.client_id")
    .select([
      "a.id", "a.lead_id", "a.client_id", "a.status", "a.price_pence", "a.pricing_rule_id", "a.notified_at", "a.created_at",
      "c.name as client_name", "c.contact_name", "c.contact_email", "c.contact_phone_e164",
    ])
    .where("a.lead_id", "=", leadId)
    .orderBy("a.created_at", "desc")
    .execute();
  if (rows.length === 0) return [];
  const history = await db
    .selectFrom("lead_assignment_status_history as h")
    .leftJoin("operators as o", (join) => join.onRef("o.id", "=", "h.actor_id").on("h.actor_type", "=", "staff_user"))
    .select(["h.assignment_id", "h.created_at", "h.from_status", "h.to_status", "h.actor_type", "h.reason", "o.email as operator_email"])
    .where("h.assignment_id", "in", rows.map((row) => row.id))
    .orderBy("h.id")
    .execute();
  return rows.map((row) => ({
    ...toAssignment(row),
    clientName: row.client_name,
    clientContactName: row.contact_name,
    clientContactEmail: row.contact_email,
    clientContactPhone: row.contact_phone_e164,
    active: (ACTIVE_STATUSES as readonly string[]).includes(row.status),
    history: history
      .filter((entry) => entry.assignment_id === row.id)
      .map((entry) => ({ at: entry.created_at, from: entry.from_status, to: entry.to_status, actor: entry.operator_email ?? entry.actor_type, reason: entry.reason })),
  }));
}

export interface HandoverData {
  reference: string;
  serviceLabel: string;
  urgency: UrgencyLevel;
  propertyType: string;
  ownership: string;
  scope: string | null;
  postcode: string;
  contact: { name: string; phone: string; email: string; notes: string | null };
  client: { name: string; contactName: string | null };
}

/** The details a business needs to contact the consumer: read ONLY for an active assignment of a lead that is not erased. */
export async function loadHandover(db: Database, assignmentId: string): Promise<HandoverData | undefined> {
  const row = await db
    .selectFrom("lead_assignments as a")
    .innerJoin("leads as l", "l.id", "a.lead_id")
    .innerJoin("lead_contacts as lc", "lc.lead_id", "l.id")
    .innerJoin("service_types as st", "st.id", "l.service_type_id")
    .innerJoin("clients as c", "c.id", "a.client_id")
    .select([
      "l.reference", "st.label as service_label", "l.urgency", "l.property_type", "l.ownership", "l.details", "l.postcode",
      "lc.full_name", "lc.phone_e164", "lc.email", "lc.notes", "c.name as client_name", "c.contact_name as client_contact_name",
    ])
    .where("a.id", "=", assignmentId)
    .where("a.status", "in", [...ACTIVE_STATUSES])
    .where("l.erased_at", "is", null)
    .where("lc.erased_at", "is", null)
    .executeTakeFirst();
  if (!row || !row.postcode || !row.full_name || !row.phone_e164 || !row.email) return undefined;
  return {
    reference: row.reference,
    serviceLabel: row.service_label,
    urgency: row.urgency,
    propertyType: row.property_type,
    ownership: row.ownership,
    scope: (row.details as { scope?: string } | null)?.scope ?? null,
    postcode: row.postcode,
    contact: { name: row.full_name, phone: row.phone_e164, email: row.email, notes: row.notes },
    client: { name: row.client_name, contactName: row.client_contact_name },
  };
}
