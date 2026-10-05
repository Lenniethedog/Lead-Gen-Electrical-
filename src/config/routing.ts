/** Routing policy. Numbers, not wiring: tested and explained in docs/03-routing-and-delivery.md. */
export const ROUTING_POLICY = {
  /** A lead that found nobody is looked at again after this long even if nothing changed (a business opens, a pause ends, midnight resets a cap). */
  unroutableRetryMinutes: 5,
  /** How many ranked candidates the router tries before giving up on a lead (each can fail on a change made while it was deciding). */
  maxReserveAttempts: 5,
  /** /api/pipeline: a lead the router should have taken is still waiting after this long, so the router is not running. */
  stalledSeconds: 60,
  /** /api/pipeline: this recent a failed routing attempt counts as "routing is failing". */
  failingWindowMinutes: 10,
  /** The default for how old a lead may be and still be routed automatically. */
  defaultMaxLeadAgeHours: 24,
} as const;

/** Bumped when the decision logic changes in a way that could give a different answer for the same facts. Stored on every run. */
export const ROUTING_ALGORITHM_VERSION = "1";
