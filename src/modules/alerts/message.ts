import { URGENCIES } from "@/config/lead-options";
import type { FraudDecision, OperatorAlertKind, UrgencyLevel } from "@/lib/db/schema";

/**
 * The content of an operator alert.
 *
 * DETERMINISM: the message is a pure function of (alert kind, immutable lead facts, configuration). It must NOT read the
 * clock or anything that changes after the alert is created (the lead's current status, how long it has waited). The
 * provider deduplicates retries by idempotency key only while the payload is IDENTICAL; a retry whose text differs
 * (a reminder that now says "17 min" instead of "15", a held lead approved in the meantime) is answered with
 * 409 invalid_idempotent_request and would be lost. tests pin this.
 *
 * PRIVACY: email is not a secure channel, so an alert carries only what is needed to decide
 * "go and look now": reference, service, outward postcode, urgency and the screening result,
 * plus a link to the protected inbox. The input type has no name/phone/email/notes fields, and
 * the query that fills it never reads lead_contacts, so personal data cannot leak in by accident.
 * (tests/integration/alerts-service.test.ts proves it end to end with a distinctive contact.)
 */
export interface AlertLeadContext {
  leadId: string;
  reference: string;
  serviceLabel: string;
  /** Outward code only (e.g. "BR6"): the full postcode is personal data. */
  postcodeOutward: string;
  urgency: UrgencyLevel;
  fraudScore: number;
  fraudDecision: FraudDecision;
  createdAt: Date;
}

export interface AlertMessageOptions {
  brandName: string;
  /** Origin of the protected inbox, no trailing slash. */
  adminBaseUrl: string;
  /** The configured reminder delay: reminders say "15+ minutes", never the (changing) actual wait. */
  reminderAfterMinutes: number;
}

/** Header values must be one line: collapse any control characters rather than trust the inputs. */
function oneLine(value: string): string {
  // \s (second replace) also covers the Unicode line and paragraph separators.
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const UK_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  dateStyle: "medium",
  timeStyle: "short",
});

/** Uses only the screening result recorded at intake (immutable), never the lead's current status. */
function screeningLine(decision: FraudDecision, score: number): string {
  if (decision === "review") return `Screened into manual review (score ${score}): check its status in the inbox`;
  if (decision === "flag") return `Flagged (score ${score}): look closely before passing it on`;
  return "Clear";
}

export function buildAlertMessage(
  kind: OperatorAlertKind,
  lead: AlertLeadContext,
  options: AlertMessageOptions,
): { subject: string; text: string } {
  const brand = oneLine(options.brandName);
  const area = oneLine(lead.postcodeOutward);
  const service = oneLine(lead.serviceLabel);
  const urgency = URGENCIES[lead.urgency];
  const urgent = lead.urgency === "emergency";
  const reminderMinutes = options.reminderAfterMinutes;

  let subject: string;
  let headline: string;
  switch (kind) {
    case "held_lead":
      subject = `[${brand}] Held lead ${lead.reference} needs review - ${service} - ${area}`;
      headline = "A lead was held for review and will not be used until you decide.";
      break;
    case "reminder":
      subject = `[${brand}] Reminder: lead ${lead.reference} still waiting (${reminderMinutes}+ min)${urgent ? " - URGENT" : ""}`;
      headline = `This lead has been waiting more than ${reminderMinutes} minutes with no action recorded.`;
      break;
    default:
      subject = `[${brand}] New lead ${lead.reference} - ${service} - ${area}${urgent ? " - URGENT" : ""}`;
      headline = "A new lead has arrived.";
  }

  const link = `${options.adminBaseUrl}/admin/leads/${lead.leadId}`;
  const text = [
    headline,
    "",
    `Reference: ${lead.reference}`,
    `Service:   ${service}`,
    `Area:      ${area}`,
    `Timing:    ${urgency.label}${urgency.hint ? ` (${urgency.hint})` : ""}`,
    `Screening: ${screeningLine(lead.fraudDecision, lead.fraudScore)}`,
    `Received:  ${UK_TIME.format(lead.createdAt)} (UK time)`,
    "",
    "Open the lead:",
    link,
    "",
    "This email deliberately contains no contact details. Sign in to the inbox to see them.",
    "",
  ].join("\n");

  return { subject, text };
}
