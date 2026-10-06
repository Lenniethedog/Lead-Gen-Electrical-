import { describe, expect, it } from "vitest";
import { buildSmsBody, buildWebhookBody, type DeliveryData } from "./messages";

const data = (overrides: Partial<DeliveryData> = {}): DeliveryData => ({
  notificationId: "n1", assignmentId: "a1", leadId: "l1", reference: "L-ABCDE-12345", serviceSlug: "fault_repair", serviceLabel: "Electrical fault or repair", scope: "no_power",
  urgency: "emergency", propertyType: "house", ownership: "owner", postcode: "BR6 0AA", postcodeOutward: "BR6", createdAt: new Date("2026-10-05T10:00:00Z"), pricePence: 3500,
  contact: { name: "Margaret Oyelaran", phone: "+447123456789", email: "m@example.com", notes: "Side gate code 4821" },
  client: { id: "c1", name: "Kestrel", contactName: "Dave", contactEmail: "dave@k.example", contactPhone: "+447123000000", webhookUrl: null, webhookSecretEnc: null },
  ...overrides,
});

describe("the text message", () => {
  it("carries what a electrician needs to act on, and nothing more: first name, phone, area, job, urgency, reference", () => {
    const body = buildSmsBody(data(), "SparkQuote Local");
    expect(body).toContain("L-ABCDE-12345");
    expect(body).toContain("Margaret,");
    expect(body).toContain("+447123456789");
    expect(body).toContain("BR6");
    expect(body).toContain("Electrical fault or repair");
    for (const withheld of ["Oyelaran", "m@example.com", "BR6 0AA", "4821"]) expect(body).not.toContain(withheld);
  });
  it("is plain ASCII on one line and never longer than two segments", () => {
    const body = buildSmsBody(data({ contact: { name: "Zoë\nÅngström ".repeat(40), phone: "+447123456789", email: "x@y.z", notes: null }, serviceLabel: "Rööf".repeat(100) }), "Brand");
    expect(body).toMatch(/^[\x20-\x7e]+$/);
    expect(body.length).toBeLessThanOrEqual(300);
  });
  it("copes with an empty name", () => expect(buildSmsBody(data({ contact: { name: " ", phone: "+447123456789", email: "x@y.z", notes: null } }), "B")).toContain("Customer,"));
});

describe("the webhook body", () => {
  it("is the full record, with a stable shape and a delivery id the receiver can de-duplicate on", () => {
    const body = JSON.parse(buildWebhookBody(data()));
    expect(body).toMatchObject({ event: "lead.assigned", delivery_id: "n1", assignment_id: "a1", price: { pence: 3500, currency: "GBP" } });
    expect(body.lead).toMatchObject({ reference: "L-ABCDE-12345", postcode: "BR6 0AA", contact: { name: "Margaret Oyelaran", phone: "+447123456789", email: "m@example.com" }, received_at: "2026-10-05T10:00:00.000Z" });
  });
  it("the same facts always give the same bytes (so the same signature)", () => expect(buildWebhookBody(data())).toBe(buildWebhookBody(data())));
});
