import { OWNERSHIPS, PROPERTY_TYPES, URGENCIES, type Ownership, type PropertyType } from "@/config/lead-options";
import type { HandoverData } from "./repo";

/**
 * The text an operator sends to a business when handing over a lead (copied into WhatsApp or an email: stage 3 has no automatic
 * delivery). This is the ONE place consumer contact details are put into outgoing text, and it is only built for an active
 * assignment of a lead whose consent allows sharing with this one business. Plain text: nothing to escape.
 */
export function buildHandoverMessage(data: HandoverData, brandName: string): { subject: string; text: string } {
  const urgency = URGENCIES[data.urgency];
  const greeting = data.client.contactName ? `Hi ${data.client.contactName},` : "Hello,";
  const lines = [
    greeting,
    "",
    `Here is a new enquiry for you from ${brandName}. It has been sent to you only.`,
    "",
    `Reference: ${data.reference}`,
    `Job:       ${data.serviceLabel}${data.scope ? ` (${data.scope.replace(/_/g, " ")})` : ""}`,
    `Timing:    ${urgency.label}${urgency.hint ? `: ${urgency.hint}` : ""}`,
    `Property:  ${PROPERTY_TYPES[data.propertyType as PropertyType]?.label ?? data.propertyType}, ${OWNERSHIPS[data.ownership as Ownership]?.label.toLowerCase() ?? data.ownership}`,
    `Postcode:  ${data.postcode}`,
    "",
    `Name:      ${data.contact.name}`,
    `Phone:     ${data.contact.phone}`,
    `Email:     ${data.contact.email}`,
    ...(data.contact.notes ? [`Note from them: ${data.contact.notes.replace(/\s+/g, " ").trim()}`] : []),
    "",
    "Please contact them as soon as you can. They asked to be contacted about this job and agreed to share their details with one local roofing business.",
    "Please use their details only for this enquiry, and delete them if they ask you to.",
    "Reply to confirm you have received it.",
  ];
  return { subject: `New enquiry ${data.reference}: ${data.serviceLabel}, ${data.postcode.split(" ")[0]}`, text: lines.join("\n") };
}
