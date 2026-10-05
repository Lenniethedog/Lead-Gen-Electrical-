import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secrets that must be RECOVERED (a webhook signing secret has to be known to sign with, so a hash would not do) are stored encrypted
 * with AES-256-GCM under a key held only in the environment. Format: `v1.<iv>.<tag>.<ciphertext>` (base64url). A stolen database
 * alone does not give the secrets; a stolen database AND the key does.
 */
const VERSION = "v1";

export function parseSecretsKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("the secrets key must be 32 random bytes, base64 encoded (openssl rand -base64 32)");
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Throws on a wrong key or a tampered value (GCM authenticates): the caller must treat that as "cannot send", never as "send anyway". */
export function decryptSecret(key: Buffer, stored: string): string {
  const [version, iv, tag, ciphertext] = stored.split(".");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("unrecognised stored secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

/** A new webhook signing secret: 32 random bytes. Shown to the operator ONCE; only the last four characters are kept in the clear, as a hint. */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}
export const secretHint = (secret: string): string => secret.slice(-4);

/** `sha256=<hex>` of HMAC-SHA256(secret, `${timestamp}.${body}`): the receiver recomputes it and rejects old timestamps (replay protection). */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** What a receiver does; used by the tests to prove the signature is verifiable with only the secret, the timestamp and the body. */
export function verifyWebhookSignature(secret: string, timestamp: number, body: string, signature: string, options: { now?: number; toleranceSeconds?: number } = {}): boolean {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (options.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
