import { sql } from "kysely";
import { HELD_STATUSES } from "@/config/client-dashboard";
import type { Database } from "@/lib/db/client";
import type { UrgencyLevel } from "@/lib/db/schema";

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
}

export async function getLeadDetail(db: Database, clientId: string, assignmentId: string): Promise<LeadDetailRow | undefined> {
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
