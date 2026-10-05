import { DELIVERY_POLICY } from "@/config/delivery";
import { URGENCIES, type Urgency } from "@/config/lead-options";

/**
 * What each channel carries. Built at SEND time from the database, never stored in the notification row, and only for an active
 * assignment of a lead whose consent allows sharing it with this one business (the repo refuses anything else).
 *
 *   email    the same full text an operator would have sent by hand (src/modules/assignments/message.ts)
 *   sms      the minimum to act on: first name, phone, area and job. SMS is not a secure channel and the details are the point of the lead
 *   webhook  the full record, over HTTPS, signed
 */
export interface DeliveryData {
  notificationId: string;
  assignmentId: string;
  leadId: string;
  reference: string;
  serviceSlug: string;
  serviceLabel: string;
  scope: string | null;
  urgency: Urgency;
  propertyType: string;
  ownership: string;
  postcode: string;
  postcodeOutward: string;
  createdAt: Date;
  pricePence: number;
  contact: { name: string; phone: string; email: string; notes: string | null };
  client: {
    id: string;
    name: string;
    contactName: string | null;
    contactEmail: string;
    contactPhone: string | null;
    webhookUrl: string | null;
    webhookSecretEnc: string | null;
  };
}

/** Plain GSM-friendly text: accents and symbols outside ASCII become "?" so one character never turns a text into a costly, longer one. */
const plain = (text: string) => text.replace(/[^\x20-\x7e]/g, "?").replace(/\s+/g, " ").trim();

export function buildSmsBody(data: DeliveryData, brandName: string): string {
  const firstName = plain(data.contact.name.split(/\s+/)[0] ?? "").slice(0, 30) || "Customer";
  const urgency = URGENCIES[data.urgency].label;
  const body = plain(`${brandName}: new enquiry ${data.reference}. ${firstName}, ${data.contact.phone}. ${data.serviceLabel}, ${data.postcodeOutward}, ${urgency}. Please call them as soon as you can.`);
  return body.length <= DELIVERY_POLICY.smsMaxChars ? body : `${body.slice(0, DELIVERY_POLICY.smsMaxChars - 1)}~`;
}

export const WEBHOOK_EVENT = "lead.assigned";

/** The webhook body. Key order is fixed so the same facts always give the same bytes (and the same signature). */
export function buildWebhookBody(data: DeliveryData): string {
  return JSON.stringify({
    event: WEBHOOK_EVENT,
    delivery_id: data.notificationId,
    assignment_id: data.assignmentId,
    lead: {
      reference: data.reference,
      received_at: data.createdAt.toISOString(),
      service: { slug: data.serviceSlug, label: data.serviceLabel },
      scope: data.scope,
      urgency: data.urgency,
      property_type: data.propertyType,
      ownership: data.ownership,
      postcode: data.postcode,
      contact: { name: data.contact.name, phone: data.contact.phone, email: data.contact.email, notes: data.contact.notes },
    },
    price: { pence: data.pricePence, currency: "GBP" },
  });
}
