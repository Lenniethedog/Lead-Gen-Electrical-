import { describe, expect, it } from "vitest";
import { wirePayload } from "../../../../tests/helpers/fixtures";
import { ValidationError } from "@/lib/errors";
import { contactSchema } from "./contact";
import { parseLeadSubmission } from "./submission";
import { postcodeStepSchema, propertyStepSchema, scopeStepSchema, serviceStepSchema, urgencyStepSchema } from "./steps";

function fieldsOf(input: unknown): Record<string, string> {
  try {
    parseLeadSubmission(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).fields ?? {};
  }
  throw new Error("expected validation to fail");
}

describe("step schemas", () => {
  it("accepts and normalises a postcode", () => {
    expect(postcodeStepSchema.parse({ postcode: " br6 0aa " })).toEqual({ postcode: "BR6 0AA" });
  });

  it("explains postcode problems in plain language", () => {
    expect(postcodeStepSchema.safeParse({ postcode: "" }).error?.issues[0]?.message).toBe("Enter the property's postcode");
    expect(postcodeStepSchema.safeParse({ postcode: "nope" }).error?.issues[0]?.message).toContain("valid UK postcode");
  });

  it("only allows the configured services and property answers", () => {
    expect(serviceStepSchema.safeParse({ service: "fault_repair" }).success).toBe(true);
    expect(serviceStepSchema.safeParse({ service: "plumbing" }).success).toBe(false);
    expect(propertyStepSchema.safeParse({ propertyType: "flat", ownership: "owner" }).success).toBe(true);
    expect(propertyStepSchema.safeParse({ propertyType: "castle", ownership: "owner" }).success).toBe(false);
    expect(urgencyStepSchema.safeParse({ urgency: "emergency" }).success).toBe(true);
    expect(urgencyStepSchema.safeParse({ urgency: "whenever" }).success).toBe(false);
  });

  it("validates the scope against the chosen service", () => {
    expect(scopeStepSchema("fault_repair").safeParse({ scope: "no_power" }).success).toBe(true);
    expect(scopeStepSchema("fault_repair").safeParse({ scope: "full_rewire" }).success).toBe(false);
    expect(scopeStepSchema("rewire").safeParse({ scope: "full_rewire" }).success).toBe(true);
  });
});

describe("contactSchema", () => {
  const valid = { name: "Alex Example", phone: "07123 456789", email: "Alex@Example.com", notes: "" };

  it("normalises name, phone and notes and keeps the email as typed (trimmed)", () => {
    const parsed = contactSchema.parse({ ...valid, name: "  Alex   Example ", email: " Alex@Example.com ", notes: "  hello \u0007 " });
    expect(parsed.name).toBe("Alex Example");
    expect(parsed.phone).toEqual({ e164: "+447123456789", kind: "mobile" });
    expect(parsed.email).toBe("Alex@Example.com");
    expect(parsed.notes).toBe("hello");
  });

  it("treats empty notes as absent", () => {
    expect(contactSchema.parse(valid).notes).toBeUndefined();
  });

  it.each(["", "A", "1234", "<script>alert(1)</script>", "Bob; DROP TABLE", "x".repeat(81)])("rejects name %j", (name) => {
    expect(contactSchema.safeParse({ ...valid, name }).success).toBe(false);
  });

  it.each(["Zoë O'Brien-Smith", "Anne-Marie", "José García", "Dr. Singh", "李 小龍", "Madonna"])("accepts name %j", (name) => {
    expect(contactSchema.safeParse({ ...valid, name }).success).toBe(true);
  });

  it.each(["", "plainaddress", "a@b", "a b@example.com", "@example.com", "a@.com"])("rejects email %j", (email) => {
    expect(contactSchema.safeParse({ ...valid, email }).success).toBe(false);
  });

  it("limits free text", () => {
    expect(contactSchema.safeParse({ ...valid, notes: "x".repeat(1001) }).success).toBe(false);
    expect(contactSchema.safeParse({ ...valid, notes: "x".repeat(1000) }).success).toBe(true);
  });
});

describe("parseLeadSubmission", () => {
  it("parses a complete submission into normalised values", () => {
    const parsed = parseLeadSubmission(wirePayload());
    expect(parsed.postcode).toBe("BR6 0AA");
    expect(parsed.contact.phone.e164).toMatch(/^\+44/);
    expect(parsed.consent.accepted).toBe(true);
    expect(parsed.context.attribution).toEqual({});
  });

  it("reports ONE message per offending field, keyed by wire path", () => {
    const fields = fieldsOf(
      wirePayload({
        postcode: "nope",
        contact: { phone: "123", email: "bad", name: "" },
        consent: { accepted: false },
      }),
    );
    expect(Object.keys(fields).sort()).toEqual(["consent.accepted", "contact.email", "contact.name", "contact.phone", "postcode"]);
    expect(fields["contact.phone"]).toContain("valid UK phone number");
  });

  it("requires explicit consent (anything but literal true fails)", () => {
    for (const accepted of [false, "true", 1, null, undefined]) {
      expect(fieldsOf(wirePayload({ consent: { accepted } }))["consent.accepted"]).toBeDefined();
    }
  });

  it("rejects a scope that does not belong to the service", () => {
    expect(fieldsOf(wirePayload({ service: "consumer_unit", scope: "no_power" })).scope).toBeDefined();
  });

  it("strips unknown fields instead of passing them through", () => {
    const parsed = parseLeadSubmission({ ...wirePayload(), isAdmin: true, status: "assigned" });
    expect(parsed).not.toHaveProperty("isAdmin");
    expect(parsed).not.toHaveProperty("status");
  });

  it("never fails because of junk attribution (it is telemetry)", () => {
    const parsed = parseLeadSubmission(
      wirePayload({ context: { attribution: { utmSource: { nested: true }, gclid: 42, landingPath: "no-slash" } } }),
    );
    expect(parsed.context.attribution).toEqual({});
  });

  it("rejects non-object bodies cleanly", () => {
    for (const body of [null, "x", 5, [], undefined]) {
      expect(Object.keys(fieldsOf(body)).length).toBeGreaterThan(0);
    }
  });

  it("bounds client-reported timing", () => {
    expect(fieldsOf(wirePayload({ context: { elapsedMs: -1 } }))["context.elapsedMs"]).toBeDefined();
    expect(fieldsOf(wirePayload({ context: { elapsedMs: 1e12 } }))["context.elapsedMs"]).toBeDefined();
  });
});
