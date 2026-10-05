import { createHmac } from "node:crypto";

/**
 * Keyed hashes for the suppression list: who we must not contact again, without remembering who they are.
 *
 * A plain SHA-256 of a phone number is not anonymous: there are only ~10^9 UK mobile numbers, so anyone with the table could
 * recover every number by hashing them all. HMAC with a secret key (PRIVACY_HASH_KEY, held in the platform's secret store, never
 * in the database or the backups) makes the table useless without the key. The kind is part of the input so a phone and an email
 * can never collide.
 *
 * The key must never be rotated casually: suppressions made under the old key would silently stop matching, and the originals are
 * gone (that is the point), so they cannot be re-hashed.
 */
export type SuppressionKind = "phone" | "email";

export function normaliseForSuppression(kind: SuppressionKind, value: string): string {
  return kind === "email" ? value.trim().toLowerCase() : value.replace(/[\s()-]/g, "");
}

export function suppressionHmac(key: string, kind: SuppressionKind, value: string): string {
  return createHmac("sha256", key).update(`${kind}:${normaliseForSuppression(kind, value)}`, "utf8").digest("hex");
}
