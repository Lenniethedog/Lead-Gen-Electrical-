/** What a business sees for each state of a lead it was given. Their words, not the database's. */
export const CLIENT_STATUS_LABELS: Record<"reserved" | "notified" | "accepted" | "disputed" | "rejected" | "refunded" | "expired" | "cancelled" | "delivery_failed", string> = {
  reserved: "New",
  notified: "New",
  accepted: "Accepted",
  disputed: "Disputed",
  rejected: "Declined",
  refunded: "Refunded",
  expired: "Expired",
  cancelled: "Taken back",
  delivery_failed: "Not delivered",
};

/** The states in which a business HOLDS the lead (and so may see the person's details): it is theirs alone and still open. */
export const HELD_STATUSES = ["reserved", "notified", "accepted", "disputed"] as const;

export const DASHBOARD_PAGE_SIZE = 200;

/** What happened when the business got in touch. Written as the business would say it. */
export const CONTACT_OUTCOMES = {
  no_answer: "No answer",
  left_voicemail: "Left a voicemail",
  spoke: "Spoke to them",
  wrong_number: "Wrong number or not them",
  not_interested: "Not interested",
  quote_sent: "Quote sent",
  won: "Won the job",
  lost: "Lost the job",
} as const;
export type ContactOutcome = keyof typeof CONTACT_OUTCOMES;
export const CONTACT_OUTCOME_CODES = Object.keys(CONTACT_OUTCOMES) as ContactOutcome[];
/** Only these carry a money amount: a quote, or the price of the job won. */
export const OUTCOMES_WITH_VALUE: readonly ContactOutcome[] = ["quote_sent", "won"];
