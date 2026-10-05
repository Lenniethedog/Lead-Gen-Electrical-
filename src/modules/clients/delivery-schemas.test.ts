import { describe, expect, it } from "vitest";
import { parseDeliverySettings, validateWebhookUrl } from "./delivery-schemas";

describe("webhook addresses", () => {
  it("accepts an https address with a name", () => expect(validateWebhookUrl(" https://crm.example.com/hooks/leads?x=1 ")).toEqual({ ok: true, url: "https://crm.example.com/hooks/leads?x=1" }));
  it("refuses http, credentials, numbers, local names, junk and absurd length", () => {
    for (const bad of ["http://crm.example.com/", "https://user:pw@crm.example.com/", "https://127.0.0.1/x", "https://10.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://db.internal/x", "https://printer.local/x", "crm.example.com", "javascript:alert(1)", "", "https://" + "a".repeat(600) + ".com"]) {
      expect(validateWebhookUrl(bad).ok, bad).toBe(false);
    }
  });
});

describe("delivery settings", () => {
  it("manual needs nothing else", () => expect(parseDeliverySettings({ deliveryMode: "manual" })).toEqual({ ok: true, value: { mode: "manual", email: false, sms: false, webhook: false, webhookUrl: null } }));
  it("automatic needs at least one channel", () => {
    const result = parseDeliverySettings({ deliveryMode: "automatic" });
    expect(result.ok).toBe(false);
    expect(parseDeliverySettings({ deliveryMode: "automatic", notifyEmail: "on" }).ok).toBe(true);
  });
  it("a ticked webhook needs a valid address, and a bad address is named even if the webhook is not ticked", () => {
    expect(parseDeliverySettings({ deliveryMode: "automatic", notifyWebhook: "on" }).ok).toBe(false);
    const bad = parseDeliverySettings({ deliveryMode: "manual", webhookUrl: "http://x.example.com" });
    expect(bad.ok).toBe(false);
    expect(parseDeliverySettings({ deliveryMode: "automatic", notifySms: "on", notifyWebhook: "on", webhookUrl: "https://x.example.com/h" })).toMatchObject({ ok: true, value: { sms: true, webhook: true } });
  });
  it("rejects an unknown mode", () => expect(parseDeliverySettings({ deliveryMode: "robot" }).ok).toBe(false));
});
