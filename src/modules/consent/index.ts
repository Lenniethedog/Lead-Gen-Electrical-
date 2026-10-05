import type { ConsentDefinition } from "@/config/consent";
import type { Database } from "@/lib/db/client";
import { sha256Hex } from "@/lib/hash";

export interface ConsentTextRecord {
  id: number;
  code: string;
  version: string;
  bodySha256: string;
  maxRecipients: number;
}

/** The wording currently in force for a consent type: the newest published, non-retired version. */
export async function findActiveConsentText(db: Database, code: string): Promise<ConsentTextRecord | undefined> {
  const row = await db
    .selectFrom("consent_texts")
    .select(["id", "code", "version", "body_sha256", "max_recipients"])
    .where("code", "=", code)
    .where("retired_at", "is", null)
    .orderBy("effective_from", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return row && { id: row.id, code: row.code, version: row.version, bodySha256: row.body_sha256, maxRecipients: row.max_recipients };
}

export class ConsentArchiveMismatchError extends Error {
  constructor(code: string, version: string) {
    super(
      `consent text ${code}@${version} differs from the archived wording. Published wording is immutable: ` +
        `bump CONSENT_VERSION in src/config/consent.ts instead of editing it (or fix BRAND_NAME).`,
    );
    this.name = "ConsentArchiveMismatchError";
  }
}

/**
 * Publishes the consent wording defined in code into the immutable archive (idempotent), retires
 * superseded versions, and refuses to continue if the archived text for this version differs from
 * what the code would render now. Used by the seed script and by the readiness check.
 */
export async function ensureConsentText(db: Database, definition: ConsentDefinition): Promise<ConsentTextRecord> {
  const bodySha256 = sha256Hex(definition.body);

  await db
    .insertInto("consent_texts")
    .values({
      code: definition.code,
      version: definition.version,
      body: definition.body,
      body_sha256: bodySha256,
      recipient_model: definition.recipientModel,
      max_recipients: definition.maxRecipients,
      channels: [...definition.channels],
    })
    .onConflict((conflict) => conflict.columns(["code", "version"]).doNothing())
    .execute();

  const archived = await db
    .selectFrom("consent_texts")
    .select(["id", "code", "version", "body_sha256", "max_recipients"])
    .where("code", "=", definition.code)
    .where("version", "=", definition.version)
    .executeTakeFirstOrThrow();

  if (archived.body_sha256 !== bodySha256) {
    throw new ConsentArchiveMismatchError(definition.code, definition.version);
  }

  await db
    .updateTable("consent_texts")
    .set({ retired_at: new Date() })
    .where("code", "=", definition.code)
    .where("version", "<>", definition.version)
    .where("retired_at", "is", null)
    .execute();

  return {
    id: archived.id,
    code: archived.code,
    version: archived.version,
    bodySha256: archived.body_sha256,
    maxRecipients: archived.max_recipients,
  };
}

/** Read-only variant for readiness probes: does the archive agree with the code? */
export async function verifyConsentArchive(db: Database, definition: ConsentDefinition): Promise<boolean> {
  const active = await findActiveConsentText(db, definition.code);
  return active !== undefined && active.version === definition.version && active.bodySha256 === sha256Hex(definition.body);
}
