import { describe, expect, it } from "vitest";
import { parseUkPhone, PHONE_EXAMPLE } from "./phone";

function ok(input: string) {
  const result = parseUkPhone(input);
  if (!result.ok) throw new Error(`expected ${JSON.stringify(input)} to be valid: ${result.message}`);
  return result.value;
}

function message(input: string): string {
  const result = parseUkPhone(input);
  if (result.ok) throw new Error(`expected ${JSON.stringify(input)} to be rejected`);
  return result.message;
}

describe("parseUkPhone: accepted numbers", () => {
  it.each([
    ["07123 456789", "+447123456789", "mobile"],
    ["07123456789", "+447123456789", "mobile"],
    ["+44 7123 456789", "+447123456789", "mobile"],
    ["0044 7123 456789", "+447123456789", "mobile"],
    ["07123-456-789", "+447123456789", "mobile"],
    [" 07123 456789 ", "+447123456789", "mobile"],
    ["07911 123456", "+447911123456", "mobile"],
    ["020 7946 0123", "+442079460123", "landline"],
    ["(020) 7946 0123", "+442079460123", "landline"],
    ["01689 123456", "+441689123456", "landline"],
    ["0161 496 0123", "+441614960123", "landline"],
  ])("accepts %j as %s (%s)", (input, e164, kind) => {
    expect(ok(input)).toEqual({ e164, kind });
  });

  it("classifies a UK VoIP number as voip (accepted, flagged by the fraud score)", () => {
    expect(ok("0561 234 5678").kind).toBe("voip");
  });

  it("uses an example number that itself passes validation", () => {
    expect(parseUkPhone(PHONE_EXAMPLE).ok).toBe(true);
  });
});

describe("parseUkPhone: rejected numbers", () => {
  it("rejects the Ofcom drama range because it is unallocated (this is real validation, not a regex)", () => {
    expect(parseUkPhone("07700 900123").ok).toBe(false);
  });

  it.each(["0800 123 4567", "0808 157 0192", "0845 123 4567", "0870 123 4567", "0900 123 4567", "070 1234 5678", "07600 123456"])(
    "rejects non-consumer number type %j with a helpful message",
    (input) => {
      expect(message(input)).toBe("Enter a mobile or landline number we can call");
    },
  );

  it.each(["12345", "abc", "07123 45678", "07123 4567890", "0712345678x", "07123 456789 ext 5", "+++", "0"])(
    "rejects malformed input %j",
    (input) => {
      expect(message(input)).toContain("Enter a valid UK phone number");
    },
  );

  it("asks for a number when empty", () => {
    expect(message("")).toBe("Enter your phone number");
    expect(message("   ")).toBe("Enter your phone number");
  });

  it("rejects non-UK numbers", () => {
    expect(message("+1 202 555 0101")).toBe("Enter a UK phone number");
    expect(message("+33 1 23 45 67 89")).toBe("Enter a UK phone number");
  });
});
