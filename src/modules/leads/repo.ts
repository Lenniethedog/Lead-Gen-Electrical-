import { sql } from "kysely";
import type { Database } from "@/lib/db/client";
import type {
  ActorType,
  FraudDecision,
  LeadStatus,
  OwnershipType,
  PropertyType,
  UrgencyLevel,
} from "@/lib/db/schema";
import type { Attribution } from "@/modules/attribution";
import type { FraudSignal } from "@/modules/fraud";

/**
 * All SQL for the lead aggregate. Every function takes a `Database`, which may be a transaction,
 * so the service decides transaction boundaries and nothing here opens its own.
 */

export interface ExistingLead {
  id: string;
  reference: string;
  /** The reference to show the consumer: a duplicate points them at the ORIGINAL enquiry. */
  publicReference: string;
  status: LeadStatus;
  payloadFingerprint: string;
}

export async function findByIdempotencyKey(db: Database, key: string): Promise<ExistingLead | undefined> {
  const row = await db
    .selectFrom("leads as l")
    .leftJoin("leads as original", "original.id", "l.duplicate_of_lead_id")
    .select(["l.id", "l.reference", "l.status", "l.payload_fingerprint", "original.reference as original_reference"])
    .where("l.idempotency_key", "=", key)
    .executeTakeFirst();
  if (!row) return undefined;
  return {
    id: row.id,
    reference: row.reference,
    publicReference: row.original_reference ?? row.reference,
    status: row.status,
    payloadFingerprint: row.payload_fingerprint,
  };
}

export interface NewLead {
  reference: string;
  idempotencyKey: string;
  payloadFingerprint: string;
  verticalId: number;
  serviceTypeId: number;
  sourceId: number;
  status: LeadStatus;
  postcode: string;
  postcodeOutward: string;
  propertyType: PropertyType;
  ownership: OwnershipType;
  urgency: UrgencyLevel;
  details: Record<string, unknown>;
  fraudScore: number;
  fraudDecision: FraudDecision;
  duplicateOfLeadId: string | null;
}

/**
 * Inserts the lead, or returns undefined if another request already used this idempotency key.
 * (A concurrent request with the same key blocks on the unique index until the first commits or
 * rolls back, then lands here - no explicit locking needed.)
 */
export async function insertLead(db: Database, lead: NewLead): Promise<{ id: string; reference: string } | undefined> {
  return db
    .insertInto("leads")
    .values({
      reference: lead.reference,
      idempotency_key: lead.idempotencyKey,
      payload_fingerprint: lead.payloadFingerprint,
      vertical_id: lead.verticalId,
      service_type_id: lead.serviceTypeId,
      source_id: lead.sourceId,
      status: lead.status,
      postcode: lead.postcode,
      postcode_outward: lead.postcodeOutward,
      property_type: lead.propertyType,
      ownership: lead.ownership,
      urgency: lead.urgency,
      details: JSON.stringify(lead.details),
      fraud_score: lead.fraudScore,
      fraud_decision: lead.fraudDecision,
      duplicate_of_lead_id: lead.duplicateOfLeadId,
    })
    .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
    .returning(["id", "reference"])
    .executeTakeFirst();
}

export interface NewContact {
  fullName: string;
  phoneE164: string;
  email: string;
  emailNormalised: string;
  notes: string | null;
  ip: string | null;
  userAgent: string | null;
}

export async function insertContact(db: Database, leadId: string, contact: NewContact): Promise<void> {
  await db
    .insertInto("lead_contacts")
    .values({
      lead_id: leadId,
      full_name: contact.fullName,
      phone_e164: contact.phoneE164,
      email: contact.email,
      email_normalised: contact.emailNormalised,
      notes: contact.notes,
      ip: contact.ip,
      user_agent: contact.userAgent,
    })
    .execute();
}

export async function insertConsentRecord(
  db: Database,
  record: { leadId: string; consentTextId: number; pagePath: string | null; ip: string | null; userAgent: string | null },
): Promise<void> {
  await db
    .insertInto("consent_records")
    .values({
      lead_id: record.leadId,
      consent_text_id: record.consentTextId,
      event: "granted",
      page_path: record.pagePath,
      ip: record.ip,
      user_agent: record.userAgent,
    })
    .execute();
}

export async function insertAttribution(db: Database, leadId: string, attribution: Attribution): Promise<void> {
  await db
    .insertInto("lead_attributions")
    .values({
      lead_id: leadId,
      utm_source: attribution.utmSource ?? null,
      utm_medium: attribution.utmMedium ?? null,
      utm_campaign: attribution.utmCampaign ?? null,
      utm_term: attribution.utmTerm ?? null,
      utm_content: attribution.utmContent ?? null,
      gclid: attribution.gclid ?? null,
      fbclid: attribution.fbclid ?? null,
      msclkid: attribution.msclkid ?? null,
      landing_path: attribution.landingPath ?? null,
      referrer_host: attribution.referrerHost ?? null,
    })
    .execute();
}

export async function insertFraudSignals(db: Database, leadId: string, signals: readonly FraudSignal[]): Promise<void> {
  if (signals.length === 0) return;
  await db
    .insertInto("lead_fraud_signals")
    .values(
      signals.map((item) => ({
        lead_id: leadId,
        code: item.code,
        weight: item.weight,
        detail: JSON.stringify(item.detail ?? {}),
      })),
    )
    .execute();
}

export interface LeadEventInput {
  type: string;
  actorType: ActorType;
  /** Business facts only. NEVER personal data (no names, phones, emails, IPs, free text). */
  payload?: Record<string, unknown>;
}

export async function insertEvents(
  db: Database,
  leadId: string,
  requestId: string,
  events: readonly LeadEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  await db
    .insertInto("lead_events")
    .values(
      events.map((event) => ({
        lead_id: leadId,
        type: event.type,
        actor_type: event.actorType,
        request_id: requestId,
        payload: JSON.stringify(event.payload ?? {}),
      })),
    )
    .execute();
}

/**
 * An earlier enquiry for the SAME JOB: same vertical + service + outward code, from the same
 * phone OR email, inside the vertical's duplicate window. A different job from the same person
 * (another service or another area) is deliberately not a duplicate. Fraud-rejected and invalid
 * leads never count: a legitimate retry must not be swallowed by a bot's earlier attempt.
 */
export async function findDuplicate(
  db: Database,
  query: {
    verticalId: number;
    serviceTypeId: number;
    postcodeOutward: string;
    phoneE164: string;
    emailNormalised: string;
    windowDays: number;
  },
): Promise<{ id: string; reference: string } | undefined> {
  if (query.windowDays <= 0) return undefined;
  return db
    .selectFrom("lead_contacts as c")
    .innerJoin("leads as l", "l.id", "c.lead_id")
    .select(["l.id", "l.reference"])
    .where("l.vertical_id", "=", query.verticalId)
    .where("l.service_type_id", "=", query.serviceTypeId)
    .where("l.postcode_outward", "=", query.postcodeOutward)
    .where("l.deleted_at", "is", null)
    .where("l.status", "not in", ["duplicate", "rejected_fraud", "invalid"])
    .where(sql<boolean>`l.created_at > now() - make_interval(days => ${query.windowDays})`)
    .where((eb) =>
      eb.or([eb("c.phone_e164", "=", query.phoneE164), eb("c.email_normalised", "=", query.emailNormalised)]),
    )
    .orderBy("l.created_at", "asc")
    .limit(1)
    .executeTakeFirst();
}

/**
 * Serialises concurrent submissions from the same person for the rest of the transaction, so two
 * simultaneous requests cannot both conclude "not a duplicate". The lock is released at COMMIT or
 * ROLLBACK. Different people never contend (the key is the phone number).
 */
export async function lockIdentity(db: Database, identityKey: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`lead-identity:${identityKey}`}, 0))`.execute(db);
}

/**
 * Sets transaction-local context read by the database triggers that write lead_status_history,
 * so every status change records WHO caused it and under which request, without the caller
 * being able to forget.
 */
export async function setAuditContext(db: Database, context: { actorType: ActorType; requestId: string }): Promise<void> {
  await sql`select set_config('app.actor_type', ${context.actorType}, true), set_config('app.request_id', ${context.requestId}, true)`.execute(
    db,
  );
}
