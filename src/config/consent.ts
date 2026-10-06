/**
 * The consent wording shown at the point of capture.
 *
 * THIS IS A LEGAL ARTEFACT. Have a solicitor approve the wording before launch (docs/04-security-
 * and-privacy.md explains what the wording must achieve and why). The rules this file enforces:
 *
 *  - Wording is VERSIONED. Never edit a published version: bump CONSENT_VERSION. The database
 *    archives every published version immutably (consent_texts) and each lead links to the exact
 *    version its consumer saw; `npm run db:seed` and /api/ready fail loudly if code and archive
 *    disagree about what a version says.
 *  - The wording states how many businesses may receive the details (max_recipients). The router
 *    must never exceed it, so changing the commercial model (e.g. shared leads) means publishing
 *    new wording first.
 *  - The checkbox is never pre-ticked and is separate from any terms acceptance.
 */

export const CONSENT_CODE = "share_with_business";
export const CONSENT_VERSION = "v1";

export type RecipientModel = "first_party" | "shared_one" | "shared_multiple";
export type ConsentChannel = "phone" | "sms" | "whatsapp" | "email";

export type ConsentSegment =
  | { kind: "text"; text: string }
  | { kind: "privacy_link"; text: string };

export interface ConsentDefinition {
  code: string;
  version: string;
  /** What is rendered next to the checkbox (the link is a real <a> in the UI). */
  segments: readonly ConsentSegment[];
  /** The same wording as plain text: this exact string is what is archived and hashed. */
  body: string;
  recipientModel: RecipientModel;
  maxRecipients: number;
  channels: readonly ConsentChannel[];
}

/**
 * Variant A (what ships): the consumer's details are shared with ONE local electrical business.
 * Written so that the controller of the onward contact is clear, the recipient is described by
 * category and number, the channels are named, and the privacy notice is linked.
 */
export function buildShareWithOneBusinessConsent(brandName: string): ConsentDefinition {
  const segments: ConsentSegment[] = [
    {
      kind: "text",
      text:
        `I agree that ${brandName} may share the details I have entered with one local electrical ` +
        `business that covers my area, so that they can contact me by phone, text message, ` +
        `WhatsApp or email about my electrical enquiry. I have read the `,
    },
    { kind: "privacy_link", text: "Privacy Notice" },
    { kind: "text", text: "." },
  ];
  return {
    code: CONSENT_CODE,
    version: CONSENT_VERSION,
    segments,
    body: segments.map((segment) => segment.text).join(""),
    recipientModel: "shared_one",
    maxRecipients: 1,
    channels: ["phone", "sms", "whatsapp", "email"],
  };
}

/** The consent definition for this deployment. */
export function buildConsent(brandName: string): ConsentDefinition {
  return buildShareWithOneBusinessConsent(brandName);
}
