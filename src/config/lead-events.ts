/**
 * Event types written to `lead_events` by the operator workflow. Shared by the alerts module (which
 * must know whether a lead has been dealt with) and the inbox (which records that it was), so
 * neither module has to import the other.
 *
 * Payloads carry ids and codes only, never personal data (docs/04).
 */
export const LEAD_EVENT = {
  /** An operator recorded that the lead has been dealt with (e.g. passed on by hand). */
  handled: "lead.handled",
  reviewApproved: "lead.review_approved",
  reviewRejected: "lead.review_rejected",
  /** Contact details and the full postcode were blanked (erasure). */
  erased: "lead.erased",
  consentWithdrawn: "lead.consent_withdrawn",
  /** The router handed the lead to a business (payload: run id and client id only). */
  routed: "lead.routed",
  /** The router found nobody (payload: run id and a reason code). Written once, when the lead first becomes unroutable. */
  unroutable: "lead.unroutable",
  /** A person took the lead back for a reason that needs a person: the router leaves it alone from here. */
  routingStopped: "lead.routing_stopped",
  /** Automatic delivery to the business failed on every channel: the assignment ended and the lead is free again (payload: assignment id and channels). */
  deliveryFailed: "lead.delivery_failed",
  /** The business it was assigned to declined it (payload: assignment id and the reason code). The router offers it to someone else. */
  declinedByBusiness: "lead.declined_by_business",
  /** A business reported a problem with the lead (payload: dispute id and reason code). */
  disputed: "lead.disputed",
  /** Staff decided a dispute (payload: dispute id, outcome and decision code). */
  disputeDecided: "lead.dispute_decided",
} as const;

/** Time-based policy for operator alerting. Tested; see docs/06-operations.md for the reasoning. */
export const ALERT_POLICY = {
  /** The reconciler only looks at leads this recent; older ones show in the inbox and in /api/pipeline. */
  lookbackHours: 72,
  /** /api/pipeline: no worker heartbeat for this long means the worker is down. */
  workerStaleSeconds: 90,
  /** /api/pipeline: an alert that was due this long ago and still is not sent. */
  overdueSeconds: 120,
  /** /api/pipeline: a new/held lead this old with no alert at all means the reconciler is not running. */
  unalertedSeconds: 150,
} as const;
