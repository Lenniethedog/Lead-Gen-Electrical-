import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/**
 * UK phone validation backed by Google's libphonenumber metadata (the `max` build, which knows
 * number TYPES). Used identically by the browser (contact step chunk) and the server.
 *
 * What we accept: valid UK mobiles and landlines. What we reject: premium-rate, shared-cost,
 * freephone, personal (070), pager and voicemail numbers - none can be a consumer's contact
 * number, and several are classic spam inputs. VoIP numbers are accepted but flagged (a weak
 * fraud signal), because some genuine households use them.
 */

export type PhoneKind = "mobile" | "landline" | "voip";

export interface ParsedPhone {
  /** E.164, e.g. "+447700900123". */
  e164: string;
  kind: PhoneKind;
}

export type PhoneParseResult = { ok: true; value: ParsedPhone } | { ok: false; message: string };

// Must itself pass validation (libphonenumber rejects the Ofcom "drama" range 07700 900xxx as unallocated).
export const PHONE_EXAMPLE = "07123 456789";

const REJECTED_TYPES = new Set([
  "PREMIUM_RATE", "SHARED_COST", "TOLL_FREE", "PERSONAL_NUMBER", "UAN", "PAGER", "VOICEMAIL",
]);

export function parseUkPhone(input: string): PhoneParseResult {
  const text = input.trim();
  if (text === "") return { ok: false, message: "Enter your phone number" };

  const invalid = { ok: false, message: `Enter a valid UK phone number, like ${PHONE_EXAMPLE}` } as const;
  // Letters mean an extension or free text; neither is a number we can dial.
  if (/[a-z]/i.test(text)) return invalid;

  const phone = parsePhoneNumberFromString(text, "GB");
  if (!phone || !phone.isValid() || phone.ext !== undefined) return invalid;
  // +44 also covers the Crown Dependencies; the postcode footprint keeps those out in practice.
  if (phone.countryCallingCode !== "44") {
    return { ok: false, message: "Enter a UK phone number" };
  }

  const type = phone.getType();
  if (type !== undefined && REJECTED_TYPES.has(type)) {
    return { ok: false, message: "Enter a mobile or landline number we can call" };
  }

  const kind: PhoneKind =
    type === "VOIP" ? "voip" : phone.number.startsWith("+447") ? "mobile" : "landline";
  return { ok: true, value: { e164: phone.number, kind } };
}
