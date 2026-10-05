/**
 * Fraud scoring model (0-100). Every signal has a weight; the score is the capped sum.
 *
 * Calibration principles (docs/04-security-and-privacy.md):
 *  - No single WEAK signal can push a legitimate user out of "accept": weak signals sit below the
 *    flag threshold on their own, so a VPN, a shared office IP or a slow Turnstile never costs a lead.
 *  - Strong signals (honeypot, blocklist, automation UA) reject alone.
 *  - Review-band outcomes are HELD for a human, not rejected, so a false positive is recoverable.
 *  - Weights live in code now; when the admin dashboard exists they move to a table with the same shape.
 */

export const FRAUD_THRESHOLDS = {
  /** score >= flag   -> accepted, but marked for attention and visible to staff */
  flag: 25,
  /** score >= review -> held; not routed until a human approves */
  review: 50,
  /** score >= reject -> rejected (stored for audit, never routed) */
  reject: 75,
} as const;

export const SIGNAL_WEIGHTS = {
  honeypot_filled: 100,
  blocklisted_identifier: 100,
  automation_user_agent: 60,
  turnstile_missing: 55,
  completed_too_fast: 50,
  tor_exit_node: 40,
  ip_velocity_high: 35,
  disposable_email: 30,
  placeholder_name: 30,
  url_in_notes: 30,
  phone_reused_with_other_identity: 25,
  email_reused_with_other_identity: 20,
  completed_quickly: 20,
  turnstile_unavailable: 20,
  ip_velocity_elevated: 15,
  voip_phone: 15,
  non_uk_country: 10,
} as const;

export type FraudSignalCode = keyof typeof SIGNAL_WEIGHTS;

export const FRAUD_LIMITS = {
  /** Fewer milliseconds than this from first render to submit is not humanly possible for 6 steps. */
  tooFastMs: 5_000,
  quickMs: 10_000,
  ipVelocity: { windowMinutes: 60, elevatedAt: 3, highAt: 6 },
  /** Look-back for "same phone/email seen with a different identity". */
  identityReuseDays: 7,
} as const;

/** Names that are almost never real. Compared case-insensitively against the whole name. */
export const PLACEHOLDER_NAMES = new Set([
  "test", "testing", "tester", "asdf", "asdfgh", "qwerty", "abc", "abcd", "xxx", "fake", "none",
  "n/a", "na", "no", "john doe", "jane doe", "mickey mouse", "donald duck", "your name", "name",
]);

/** Client libraries and headless browsers that a real consumer's phone never reports. */
export const AUTOMATION_USER_AGENT =
  /(HeadlessChrome|PhantomJS|python-requests|python-urllib|aiohttp|curl\/|wget\/|Go-http-client|axios\/|node-fetch|undici|okhttp|libwww-perl|scrapy|httpclient|Java\/)/i;
