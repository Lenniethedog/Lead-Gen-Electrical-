/**
 * Disputes (stage 6, docs/00 D55-D58). A business says "there is a problem with this lead"; staff decide. Everything staff choose is a CODE
 * from a closed list (never free text); only what the business itself writes is free text, and that is cleared if the person is erased.
 */
export const DISPUTE_WINDOW_DAYS = 7;

export const DISPUTE_REASONS = {
  wrong_number: "The phone number is wrong, or it is not them",
  not_homeowner: "They do not own or manage the property",
  out_of_area: "The property is outside my area",
  duplicate: "I already had this enquiry",
  spam: "It is spam or not a real enquiry",
  not_as_described: "The job is not what was described",
  other: "Something else",
} as const;
export type DisputeReason = keyof typeof DISPUTE_REASONS;
export const DISPUTE_REASON_CODES = Object.keys(DISPUTE_REASONS) as DisputeReason[];

export const DISPUTE_RESOLUTIONS = {
  credit_refund: "Refund the charge",
  replacement_lead: "Refund the charge, and the business gets a replacement from staff",
} as const;
export type DisputeResolution = keyof typeof DISPUTE_RESOLUTIONS;
export const DISPUTE_RESOLUTION_CODES = Object.keys(DISPUTE_RESOLUTIONS) as DisputeResolution[];

/** Why staff decided as they did. Each belongs to one outcome. */
export const DISPUTE_DECISION_REASONS = {
  confirmed_bad_number: { outcome: "upheld", label: "We checked: the number or person is wrong" },
  confirmed_not_owner: { outcome: "upheld", label: "We checked: they are not the owner" },
  confirmed_out_of_area: { outcome: "upheld", label: "We checked: it is outside the business's area" },
  confirmed_duplicate: { outcome: "upheld", label: "We checked: it is a duplicate" },
  confirmed_spam: { outcome: "upheld", label: "We checked: it is not a real enquiry" },
  goodwill: { outcome: "upheld", label: "Refunded as goodwill" },
  contact_was_made: { outcome: "rejected", label: "The lead was reached and the details were right" },
  details_were_correct: { outcome: "rejected", label: "The details were as given and in the business's area" },
  not_enough_evidence: { outcome: "rejected", label: "Not enough to show a problem with the lead" },
} as const;
export type DisputeDecisionReason = keyof typeof DISPUTE_DECISION_REASONS;
export const DISPUTE_DECISION_REASON_CODES = Object.keys(DISPUTE_DECISION_REASONS) as DisputeDecisionReason[];

export const DISPUTE_STATUS_LABELS = {
  open: "With us",
  under_review: "Being looked at",
  upheld: "Upheld: refunded",
  rejected: "Not upheld",
  withdrawn: "Withdrawn",
} as const;
export type DisputeStatus = keyof typeof DISPUTE_STATUS_LABELS;
