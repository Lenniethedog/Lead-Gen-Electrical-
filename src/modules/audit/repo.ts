import type { Database } from "@/lib/db/client";
import type { ActorType } from "@/lib/db/schema";

/**
 * The append-only audit trail of staff actions: who did what, to which record, why, and what changed.
 * It records BUSINESS facts only. A consumer's name, phone, email, notes or full postcode must never appear in it
 * (docs/04): writeAudit refuses an entry whose before/after contains such a field, so the rule cannot be broken by
 * a careless caller. (Client business contact details are business data and are allowed.)
 */
export interface AuditEntry {
  actorType?: ActorType;
  actorId: string | null;
  /** dotted, lower-case: `client.created`, `assignment.reassigned`, `privacy.lead_erased` */
  action: string;
  entityType: string;
  entityId: string;
  reason?: string | undefined;
  before?: unknown;
  after?: unknown;
  requestId?: string | undefined;
}

/** Field names that carry consumer personal data (lead_contacts and the full postcode). */
const CONSUMER_FIELDS = new Set([
  "full_name", "fullname", "phone", "phone_e164", "email", "email_normalised", "emailnormalised", "notes_from_consumer",
  "consumer_name", "consumer_phone", "consumer_email", "postcode", "ip", "user_agent", "useragent", "consumer_notes",
]);

export class AuditPrivacyError extends Error {
  constructor(readonly field: string) {
    super(`audit entries must not contain consumer personal data (field "${field}")`);
    this.name = "AuditPrivacyError";
  }
}

function scan(value: unknown, depth = 0): void {
  if (value === null || typeof value !== "object" || depth > 6) return;
  if (Array.isArray(value)) return void value.forEach((item) => scan(item, depth + 1));
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (CONSUMER_FIELDS.has(key.toLowerCase())) throw new AuditPrivacyError(key);
    scan(inner, depth + 1);
  }
}

export async function writeAudit(db: Database, entry: AuditEntry): Promise<void> {
  scan(entry.before);
  scan(entry.after);
  await db
    .insertInto("audit_logs")
    .values({
      actor_type: entry.actorType ?? "staff_user",
      actor_id: entry.actorId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      reason: entry.reason ?? null,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      request_id: entry.requestId ?? null,
    })
    .execute();
}
