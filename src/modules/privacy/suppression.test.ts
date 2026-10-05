import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normaliseForSuppression, suppressionHmac } from "./suppression";

const KEY = "unit-test-privacy-key-0123456789-abcdef";

describe("suppressionHmac", () => {
  it("is a 64-character hex digest, deterministic for the same input", () => {
    const hash = suppressionHmac(KEY, "phone", "+447911123456");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(suppressionHmac(KEY, "phone", "+447911123456")).toBe(hash);
  });

  it("is NOT a plain hash: without the key, hashing every candidate number recovers nothing", () => {
    const phone = "+447911123456";
    const plain = createHash("sha256").update(phone).digest("hex");
    const plainWithKind = createHash("sha256").update(`phone:${phone}`).digest("hex");
    const keyed = suppressionHmac(KEY, "phone", phone);
    expect(keyed).not.toBe(plain);
    expect(keyed).not.toBe(plainWithKind);
  });

  it("depends on the key, so a leaked table is useless without it", () => {
    expect(suppressionHmac(KEY, "email", "a@example.com")).not.toBe(suppressionHmac(KEY + "x", "email", "a@example.com"));
  });

  it("keeps a phone and an email apart even if the strings were equal", () => {
    expect(suppressionHmac(KEY, "phone", "x")).not.toBe(suppressionHmac(KEY, "email", "x"));
  });

  it("matches however the value was written: email case and spaces, phone punctuation", () => {
    expect(suppressionHmac(KEY, "email", " Jane.Doe@Example.COM ")).toBe(suppressionHmac(KEY, "email", "jane.doe@example.com"));
    expect(suppressionHmac(KEY, "phone", "+44 7911 123456")).toBe(suppressionHmac(KEY, "phone", "+447911123456"));
    expect(suppressionHmac(KEY, "phone", "+44 (7911) 123-456")).toBe(suppressionHmac(KEY, "phone", "+447911123456"));
    expect(normaliseForSuppression("email", "A@B.CO")).toBe("a@b.co");
  });

  it("distinguishes different people", () => {
    expect(suppressionHmac(KEY, "phone", "+447911123456")).not.toBe(suppressionHmac(KEY, "phone", "+447911123457"));
    expect(suppressionHmac(KEY, "email", "a@example.com")).not.toBe(suppressionHmac(KEY, "email", "b@example.com"));
  });
});
