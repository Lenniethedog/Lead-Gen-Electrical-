import { createHash, randomBytes } from "node:crypto";

/**
 * A secret the browser holds (a sign-in link, a session cookie). 256 random bits, URL-safe. Only its SHA-256 is ever stored:
 * a database leak or backup then yields nothing that can be used to sign in. SHA-256 (not a slow hash) is right here because the
 * input is already unguessable; there is no password to brute-force.
 */
export function newSecret(): { raw: string; hash: Buffer } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashSecret(raw) };
}

export function hashSecret(raw: string): Buffer {
  return createHash("sha256").update(raw, "utf8").digest();
}

/** Exactly what `newSecret` makes: 43 URL-safe characters. Anything else cannot be ours, so it never reaches the database. */
export function looksLikeSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
