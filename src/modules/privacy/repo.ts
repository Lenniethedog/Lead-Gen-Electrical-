import { sql } from "kysely";
import type { Database } from "@/lib/db/client";
import type { LeadStatus } from "@/lib/db/schema";
import type { SuppressionKind } from "./suppression";

/** All SQL for privacy actions. Takes a `Database` (possibly a transaction). */

export interface LeadForPrivacy {
  id: string;
  reference: string;
  status: LeadStatus;
  createdAt: Date;
  erased: boolean;
}

export async function lockLeadForPrivacy(db: Database, leadId: string): Promise<LeadForPrivacy | undefined> {
  const row = await db.selectFrom("leads").select(["id", "reference", "status", "created_at", "erased_at"]).where("id", "=", leadId).forUpdate().executeTakeFirst();
  return row ? { id: row.id, reference: row.reference, status: row.status, createdAt: row.created_at, erased: row.erased_at !== null } : undefined;
}

/** The consumer's phone and email, or undefined if the contact row is already erased. */
export async function readIdentity(db: Database, leadId: string): Promise<{ phone: string; email: string } | undefined> {
  const row = await db.selectFrom("lead_contacts").select(["phone_e164", "email_normalised"]).where("lead_id", "=", leadId).where("erased_at", "is", null).executeTakeFirst();
  return row?.phone_e164 && row.email_normalised ? { phone: row.phone_e164, email: row.email_normalised } : undefined;
}

export async function insertSuppressions(
  db: Database,
  entries: Array<{ kind: SuppressionKind; hmac: string }>,
  reason: "erasure" | "withdrawn_consent" | "opt_out" | "tps",
): Promise<void> {
  if (entries.length === 0) return;
  // A repeat request for someone already suppressed refreshes `last_requested_at`: their LATEST request to stop is what counts
  // (migration 0004). The first reason and created_at are kept.
  await db
    .insertInto("suppressions")
    .values(entries.map((entry) => ({ kind: entry.kind, value_hmac: entry.hmac, reason })))
    .onConflict((conflict) => conflict.columns(["kind", "value_hmac"]).doUpdateSet({ last_requested_at: sql<Date>`now()` }))
    .execute();
}

/** True if the consumer asked us to stop AFTER this lead was created: any of these keyed hashes was (re)requested since then. */
export async function suppressedSince(db: Database, entries: Array<{ kind: SuppressionKind; hmac: string }>, since: Date): Promise<boolean> {
  if (entries.length === 0) return false;
  const row = await db
    .selectFrom("suppressions")
    .select("id")
    .where("last_requested_at", ">", since)
    .where((eb) => eb.or(entries.map((entry) => eb.and([eb("kind", "=", entry.kind), eb("value_hmac", "=", entry.hmac)]))))
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/** Blanks every personal field in one statement each; the table CHECKs make a half-erased row impossible. */
export async function blankPersonalData(db: Database, leadId: string): Promise<void> {
  await db
    .updateTable("lead_contacts")
    .set({ full_name: null, phone_e164: null, email: null, email_normalised: null, notes: null, ip: null, user_agent: null, erased_at: sql<Date>`now()` })
    .where("lead_id", "=", leadId)
    .where("erased_at", "is", null)
    .execute();
  await db.updateTable("leads").set({ postcode: null, erased_at: sql<Date>`now()` }).where("id", "=", leadId).execute();
  // What a business wrote about its calls to this person may name them: it goes too. (The outcome and the amount stay: they describe the business's work.)
  // ...and what it wrote when it reported a problem with the lead.
  await sql`update disputes set description = null where description is not null and assignment_id in (select id from lead_assignments where lead_id = ${leadId})`.execute(db);
  await sql`update assignment_contact_attempts set note = null where note is not null and assignment_id in (select id from lead_assignments where lead_id = ${leadId})`.execute(db);
  // Click ids and landing URLs are not contact columns, but they routinely carry the person's address,
  // name or phone (query strings, search terms). Erasure clears every one of them.
  await db
    .updateTable("lead_attributions")
    .set({
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_term: null,
      utm_content: null,
      gclid: null,
      fbclid: null,
      msclkid: null,
      landing_path: null,
      referrer_host: null,
    })
    .where("lead_id", "=", leadId)
    .execute();
}

export async function hasWithdrawal(db: Database, leadId: string): Promise<boolean> {
  return (await db.selectFrom("consent_records").select("id").where("lead_id", "=", leadId).where("event", "=", "withdrawn").limit(1).executeTakeFirst()) !== undefined;
}

export async function insertWithdrawal(db: Database, leadId: string): Promise<boolean> {
  const grant = await db.selectFrom("consent_records").select("consent_text_id").where("lead_id", "=", leadId).where("event", "=", "granted").orderBy("captured_at").executeTakeFirst();
  if (!grant) return false;
  await db.insertInto("consent_records").values({ lead_id: leadId, consent_text_id: grant.consent_text_id, event: "withdrawn", method: "operator_request" }).execute();
  return true;
}

export interface HolderNotice {
  assignmentId: string;
  clientId: string;
  clientName: string;
  clientContactEmail: string;
  clientContactName: string | null;
  status: string;
  reference: string;
}

/** Businesses currently holding the lead: they are separate controllers and must be told to stop using / delete the details. */
export async function holders(db: Database, leadId: string): Promise<HolderNotice[]> {
  const rows = await db
    .selectFrom("lead_assignments as a")
    .innerJoin("clients as c", "c.id", "a.client_id")
    .innerJoin("leads as l", "l.id", "a.lead_id")
    .select(["a.id", "a.client_id", "a.status", "c.name", "c.contact_email", "c.contact_name", "l.reference"])
    .where("a.lead_id", "=", leadId)
    .where("a.status", "in", ["reserved", "notified", "accepted", "disputed"])
    .orderBy("a.created_at")
    .execute();
  return rows.map((row) => ({ assignmentId: row.id, clientId: row.client_id, clientName: row.name, clientContactEmail: row.contact_email, clientContactName: row.contact_name, status: row.status, reference: row.reference }));
}
