import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../src/lib/db/client";
import type { FraudDecision, LeadStatus } from "../../src/lib/db/schema";
import { generateLeadReference } from "../../src/lib/ids";

let clientCounter = 0;

/** A minimal active client (business details are fixtures). Pass `verticalId` to avoid a lookup. */
export async function insertRawClient(
  db: Database,
  overrides: { name?: string; status?: "prospect" | "active" | "paused" | "suspended" | "churned"; email?: string; services?: boolean } = {},
): Promise<{ id: string; email: string }> {
  clientCounter += 1;
  const vertical = await db.selectFrom("verticals").select("id").where("slug", "=", "electrical").executeTakeFirstOrThrow();
  const email = overrides.email ?? `client${clientCounter}.${randomBytes(3).toString("hex")}@example.com`;
  const client = await db
    .insertInto("clients")
    .values({ vertical_id: vertical.id, name: overrides.name ?? `Client ${clientCounter}`, contact_email: email, status: overrides.status ?? "active" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: client.id, email };
}

/** The run that explains an automatic assignment (the database refuses a `router` assignment without one). */
export async function insertRawRoutingRun(db: Database, leadId: string, clientId: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into routing_runs (lead_id, outcome, rules, algorithm_version, chosen_client_id)
    values (${leadId}, 'assigned', '[]'::jsonb, 'test-fixture', ${clientId}) returning id`.execute(db);
  return rows[0]!.id;
}

/**
 * Gives `leadId` an ACTIVE exclusive assignment to a (new or given) client, the legitimate way: commit the sale model,
 * then insert. Needed wherever a test wants a lead that really is held, since the database refuses `assigned` without one.
 */
export async function insertRawAssignment(
  db: Database,
  leadId: string,
  overrides: { clientId?: string; status?: "reserved" | "notified" | "accepted" } = {},
): Promise<{ id: string; clientId: string }> {
  const clientId = overrides.clientId ?? (await insertRawClient(db)).id;
  await sql`update leads set sale_model = 'exclusive' where id = ${leadId} and sale_model is null`.execute(db);
  const run = await insertRawRoutingRun(db, leadId, clientId);
  const row = await db
    .insertInto("lead_assignments")
    .values({ lead_id: leadId, client_id: clientId, sale_type: "exclusive", assigned_by: "router", routing_run_id: run, price_pence: 3500, status: overrides.status ?? "reserved" })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: row.id, clientId };
}

/**
 * Inserts a minimal, valid lead (plus the contact and consent rows the database demands at COMMIT)
 * straight through SQL, bypassing the service. For testing database guarantees in isolation.
 */
export async function insertRawLead(
  db: Database,
  overrides: {
    status?: LeadStatus;
    fraudDecision?: FraudDecision;
    duplicateOfLeadId?: string | null;
    createdAt?: Date;
    /** Defaults to BR6 0AA. Must be one of the seeded development postcodes for coverage to find it. */
    postcode?: string;
    urgency?: "emergency" | "within_2_weeks" | "within_1_month" | "just_planning";
    isTest?: boolean;
    skipConsent?: boolean;
    skipContact?: boolean;
    phone?: string;
    /** Defaults to raw@example.com. Pass a unique address when tests must not share a person (suppression is per identity). */
    email?: string;
    /** Use this consent wording instead of the seeded one (e.g. a multi-recipient text for shared-lead tests). */
    consentTextId?: number;
  } = {},
): Promise<{ id: string; reference: string }> {
  const [vertical, serviceType, source, consentText] = await Promise.all([
    db.selectFrom("verticals").select("id").where("slug", "=", "electrical").executeTakeFirstOrThrow(),
    db.selectFrom("service_types").select("id").where("slug", "=", "fault_repair").executeTakeFirstOrThrow(),
    db.selectFrom("lead_sources").select("id").where("slug", "=", "direct").executeTakeFirstOrThrow(),
    db.selectFrom("consent_texts").select("id").executeTakeFirstOrThrow(),
  ]);

  return db.transaction().execute(async (trx) => {
    const reference = generateLeadReference();
    const lead = await trx
      .insertInto("leads")
      .values({
        reference,
        idempotency_key: crypto.randomUUID(),
        payload_fingerprint: randomBytes(32).toString("hex"),
        vertical_id: vertical.id,
        service_type_id: serviceType.id,
        source_id: source.id,
        status: overrides.status ?? "new",
        postcode: overrides.postcode ?? "BR6 0AA",
        postcode_outward: (overrides.postcode ?? "BR6 0AA").split(" ")[0]!,
        property_type: "house",
        ownership: "owner",
        urgency: overrides.urgency ?? "within_2_weeks",
        ...(overrides.isTest && { is_test: true }),
        details: JSON.stringify({ scope: "no_power" }),
        fraud_score: 0,
        fraud_decision: overrides.fraudDecision ?? "accept",
        duplicate_of_lead_id: overrides.duplicateOfLeadId ?? null,
        ...(overrides.createdAt && { created_at: overrides.createdAt }),
      })
      .returning(["id", "reference"])
      .executeTakeFirstOrThrow();

    if (!overrides.skipContact) {
      await trx
        .insertInto("lead_contacts")
        .values({
          lead_id: lead.id,
          full_name: "Raw Fixture",
          phone_e164: overrides.phone ?? "+447911100999",
          email: overrides.email ?? "raw@example.com",
          email_normalised: overrides.email ?? "raw@example.com",
        })
        .execute();
    }
    if (!overrides.skipConsent) {
      await trx.insertInto("consent_records").values({ lead_id: lead.id, consent_text_id: overrides.consentTextId ?? consentText.id }).execute();
    }
    // A lead created as `assigned` must really be held by someone (checked at COMMIT by the database).
    if (overrides.status === "assigned") await insertRawAssignment(trx, lead.id);
    return lead;
  });
}
