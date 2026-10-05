import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, generateWebhookSecret, parseSecretsKey, secretHint, signWebhook, verifyWebhookSignature } from "./secrets";

const key = randomBytes(32);

describe("encrypted secrets", () => {
  it("round-trips, and the stored form does not contain the secret", () => {
    const secret = generateWebhookSecret();
    const stored = encryptSecret(key, secret);
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(secret.slice(6, 20));
    expect(decryptSecret(key, stored)).toBe(secret);
  });
  it("uses a fresh nonce each time, so the same secret never encrypts the same way twice", () => {
    expect(encryptSecret(key, "x")).not.toBe(encryptSecret(key, "x"));
  });
  it("refuses a wrong key, a tampered value and garbage instead of returning something", () => {
    const stored = encryptSecret(key, "top secret");
    expect(() => decryptSecret(randomBytes(32), stored)).toThrow();
    const [v, iv, tag, ct] = stored.split(".");
    expect(() => decryptSecret(key, [v, iv, tag, Buffer.from("AAAA", "base64url").toString("base64url") + ct].join("."))).toThrow();
    expect(() => decryptSecret(key, "nonsense")).toThrow();
    expect(() => decryptSecret(key, `v2.${iv}.${tag}.${ct}`)).toThrow();
  });
  it("accepts only a 32 byte key", () => {
    expect(parseSecretsKey(randomBytes(32).toString("base64")).length).toBe(32);
    expect(() => parseSecretsKey(randomBytes(16).toString("base64"))).toThrow();
    expect(() => parseSecretsKey("")).toThrow();
  });
  it("secrets are long, prefixed and have a short hint", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(secretHint(secret)).toHaveLength(4);
    expect(generateWebhookSecret()).not.toBe(secret);
  });
});

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ a: 1 });
  it("a receiver can verify with the secret, the timestamp and the body, and a known value is stable", () => {
    // The documented scheme, computed independently: HMAC-SHA256 over "<timestamp>.<body>", hex, prefixed.
    expect(signWebhook(secret, 1_700_000_000, body)).toBe(`sha256=${createHmac("sha256", secret).update(`1700000000.${body}`).digest("hex")}`);
    const signature = signWebhook(secret, 1_700_000_000, body);
    expect(verifyWebhookSignature(secret, 1_700_000_000, body, signature, { now: 1_700_000_100 })).toBe(true);
  });
  it("rejects a changed body, a changed timestamp, the wrong secret, and an old timestamp (replay)", () => {
    const signature = signWebhook(secret, 1_700_000_000, body);
    expect(verifyWebhookSignature(secret, 1_700_000_000, body + " ", signature, { now: 1_700_000_001 })).toBe(false);
    expect(verifyWebhookSignature(secret, 1_700_000_001, body, signature, { now: 1_700_000_001 })).toBe(false);
    expect(verifyWebhookSignature("other", 1_700_000_000, body, signature, { now: 1_700_000_001 })).toBe(false);
    expect(verifyWebhookSignature(secret, 1_700_000_000, body, signature, { now: 1_700_000_000 + 301 })).toBe(false);
    expect(verifyWebhookSignature(secret, 1_700_000_000, body, "sha256=short", { now: 1_700_000_001 })).toBe(false);
  });
});
