import { randomBytes } from "node:crypto";

// Crockford base32: no I, L, O or U, so a reference read out over the phone is hard to mishear.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Human-friendly lead reference, e.g. "L-7K3M9-P2Q4T" (10 characters = 50 bits of randomness).
 * Uniqueness is enforced by a UNIQUE constraint; at 50 bits a collision is vanishingly rare and a
 * client retry (same idempotency key) simply draws a new reference.
 */
export function generateLeadReference(): string {
  const chars = Array.from(randomBytes(10), (byte) => ALPHABET.charAt(byte & 31)).join("");
  return `L-${chars.slice(0, 5)}-${chars.slice(5)}`;
}

export const LEAD_REFERENCE_PATTERN = /^L-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/;
