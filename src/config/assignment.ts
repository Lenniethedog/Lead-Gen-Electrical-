/**
 * Why an assignment was ended or moved. A CLOSED list, deliberately: the reason is stored in assignment history and the audit
 * trail, and free text would let a consumer's phone number or name end up there (docs/04). The codes also make "why do leads
 * come back?" measurable.
 */
export const CANCEL_REASONS = {
  client_declined: "The business declined it",
  no_response: "No response from the business",
  wrong_area: "It is outside what the business covers",
  client_unavailable: "The business cannot take it right now",
  quality_issue: "Concerns about the lead's quality",
  consumer_request: "The consumer asked us to",
  other: "Another reason",
} as const;
export type CancelReason = keyof typeof CANCEL_REASONS;
export const CANCEL_REASON_CODES = Object.keys(CANCEL_REASONS) as CancelReason[];

/**
 * Why a business declines a lead it was given (chosen on the dashboard). Also a closed list: it is stored with the assignment and in
 * history. A decline always sends the lead on to a DIFFERENT business (the router never offers it back); the reasons exist to measure
 * why leads are declined (coverage that is too wide, capacity, wrong kind of work), not to change what happens next.
 */
export const CLIENT_DECLINE_REASONS = {
  wrong_area: "It is outside the area I cover",
  too_busy: "I am too busy to take it on",
  not_my_work: "It is not the kind of work I do",
  other: "Another reason",
} as const;
export type ClientDeclineReason = keyof typeof CLIENT_DECLINE_REASONS;
export const CLIENT_DECLINE_REASON_CODES = Object.keys(CLIENT_DECLINE_REASONS) as ClientDeclineReason[];

/** Reasons the SYSTEM records itself (never chosen from a form). */
export const SYSTEM_REASONS = {
  manual_assignment: "Assigned by an operator",
  coverage_exception: "Assigned by an operator outside the client's coverage",
  marked_sent: "Operator sent it to the business",
  consent_withdrawn: "The consumer withdrew consent",
  erasure_request: "The consumer asked for their data to be erased",
  auto_routed: "Routed automatically",
  accepted_by_business: "The business accepted it",
  routing_no_candidates: "No business could take it",
  routing_stopped: "Routing declined to handle it",
  delivered_automatically: "Delivered to the business automatically",
  delivery_failed: "Could not be delivered to the business",
} as const;
export type SystemReason = keyof typeof SYSTEM_REASONS;

/**
 * Taking a lead back for one of these reasons means a PERSON should decide what happens next, so the router must not pick it up
 * again by itself (the lead returns to `new` with a "routing stopped" event). The other reasons (the business declined, did not
 * answer, is the wrong area, is unavailable) are exactly what automatic re-routing to a different business is for.
 */
export const STOP_ROUTING_REASONS: readonly CancelReason[] = ["quality_issue", "consumer_request", "other"];
