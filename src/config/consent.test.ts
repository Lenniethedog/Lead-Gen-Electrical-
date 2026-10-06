import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/hash";
import { buildConsent, buildShareWithOneBusinessConsent, CONSENT_CODE, CONSENT_VERSION } from "./consent";

describe("consent wording", () => {
  const consent = buildConsent("Kent Spark Match");

  it("is versioned and identifiable", () => {
    expect(consent.code).toBe(CONSENT_CODE);
    expect(consent.version).toBe(CONSENT_VERSION);
    expect(consent.version).toMatch(/^v[0-9]+$/);
  });

  it("archives exactly what the consumer reads (segments join to the plain body)", () => {
    expect(consent.segments.map((segment) => segment.text).join("")).toBe(consent.body);
  });

  it("names the controller, the number and category of recipients, every channel and the privacy notice", () => {
    expect(consent.body).toContain("Kent Spark Match");
    expect(consent.body).toContain("one local electrical business");
    for (const phrase of ["phone", "text message", "WhatsApp", "email"]) expect(consent.body).toContain(phrase);
    expect(consent.body).toContain("Privacy Notice");
    expect(consent.segments.filter((segment) => segment.kind === "privacy_link")).toHaveLength(1);
  });

  it("keeps recipient model and maximum recipients consistent with the wording", () => {
    expect(consent.recipientModel).toBe("shared_one");
    expect(consent.maxRecipients).toBe(1);
    expect(consent.channels).toEqual(["phone", "sms", "whatsapp", "email"]);
  });

  it("changes when the brand changes, which is what forces a version bump (see ensureConsentText)", () => {
    expect(buildShareWithOneBusinessConsent("Other Brand").body).not.toBe(consent.body);
  });

  it("is the electrical wording exactly as published (share_with_business@v1): changing it needs a new version, not an edit", () => {
    const published = buildConsent("SparkQuote Local");
    expect(published.body).toBe(
      "I agree that SparkQuote Local may share the details I have entered with one local electrical business that covers my area, " +
        "so that they can contact me by phone, text message, WhatsApp or email about my electrical enquiry. I have read the Privacy Notice.",
    );
    // The hash the seed archived for v1 (consent_texts.body_sha256). If this fails, bump CONSENT_VERSION instead.
    expect(sha256Hex(published.body)).toBe("9f2cc74c2ea611e099c589d51a0f7947aadaed5249418ee595ec8253408ce3ed");
    expect(published.body).not.toMatch(/roof/i);
  });
});
