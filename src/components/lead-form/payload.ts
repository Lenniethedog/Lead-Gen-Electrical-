import type { SubmitPayload } from "./api";
import type { WireAttribution } from "./attribution";
import type { FormValues } from "./state";

export interface SubmitExtras {
  turnstileToken: string | undefined;
  honeypot: string;
  consentVersion: string;
  elapsedMs: number;
  pagePath: string;
  attribution: WireAttribution;
}

/**
 * Builds the wire payload. Values are sent as the user typed them: normalising (postcode format,
 * phone to E.164, email case) is the SERVER's job, so the rules exist in exactly one place that
 * is authoritative. Throws if the form is incomplete - callers check firstIncompleteStep first.
 */
export function buildPayload(values: FormValues, extras: SubmitExtras): SubmitPayload {
  const { service, propertyType, ownership, scope, urgency } = values;
  if (!service || !propertyType || !ownership || !scope || !urgency) {
    throw new Error("buildPayload called with an incomplete form");
  }
  return {
    service,
    postcode: values.postcode,
    propertyType,
    ownership,
    scope,
    urgency,
    contact: { name: values.name, phone: values.phone, email: values.email, notes: values.notes },
    consent: { accepted: true, textVersion: extras.consentVersion },
    context: {
      elapsedMs: Math.max(0, Math.round(extras.elapsedMs)),
      ...(extras.turnstileToken !== undefined && { turnstileToken: extras.turnstileToken }),
      honeypot: extras.honeypot,
      pagePath: extras.pagePath,
      attribution: extras.attribution,
    },
  };
}
