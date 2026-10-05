/** Why the router would leave a lead alone right now. A closed list; pure, so the admin pages can import it without the database code. */
export type Blocker =
  | "routing_off"
  | "before_routing_was_enabled"
  | "too_old"
  | "not_routable_status"
  | "handled_by_a_person"
  | "routing_stopped"
  | "test_lead"
  | "erased"
  | "waiting_to_retry";

export const BLOCKER_TEXT: Record<Blocker, string> = {
  routing_off: "Automatic routing is switched off",
  before_routing_was_enabled: "The lead arrived before automatic routing was switched on, so it is never routed automatically",
  too_old: "The lead is older than the age limit for automatic routing",
  not_routable_status: "The lead is not waiting to be routed (it is held, assigned, closed, or being handled)",
  handled_by_a_person: "A person marked it handled",
  routing_stopped: "A person took it back for a reason that needs a person to decide",
  test_lead: "It is a test lead",
  erased: "Its personal data was erased",
  waiting_to_retry: "It found nobody recently and is waiting for the next look",
};

/** Why a routing run did not assign the lead (stored as a short code on the run). */
export const RUN_REASON_TEXT: Record<string, string> = {
  price_required: "No price rule matches this lead (the router never invents a price)",
  no_eligible_client: "No business could take it",
  consent_withdrawn: "The consumer withdrew consent",
  suppressed: "The consumer has asked us to stop contacting them",
  no_consent_to_share: "The consumer's consent does not allow passing their details to a business",
  rules_invalid: "The routing rules are not valid, so nothing was routed",
  exception: "Something unexpected went wrong",
  unknown_postcode: "The postcode is not in the postcode directory",
  no_postcode: "The lead has no postcode",
};
