/**
 * Why an operator approved or rejected a held lead. A closed set, deliberately: free text would be
 * stored in lead_status_history and could contain a consumer's phone number or name, which must
 * never live outside lead_contacts (docs/04). The codes also make the false-positive rate of the
 * fraud screen measurable (docs/06): "approved as genuine" is exactly a false positive.
 */
export const APPROVE_REASONS = {
  genuine: "Looks like a genuine enquiry",
  verified_contact: "I checked the details (e.g. spoke to them)",
} as const;

export const REJECT_REASONS = {
  spam_or_bot: "Spam or a bot",
  fake_details: "Fake or unusable contact details",
  test_submission: "A test submission",
  abusive: "Abusive or irrelevant",
} as const;

export type ApproveReason = keyof typeof APPROVE_REASONS;
export type RejectReason = keyof typeof REJECT_REASONS;

export const APPROVE_REASON_CODES = Object.keys(APPROVE_REASONS) as ApproveReason[];
export const REJECT_REASON_CODES = Object.keys(REJECT_REASONS) as RejectReason[];
