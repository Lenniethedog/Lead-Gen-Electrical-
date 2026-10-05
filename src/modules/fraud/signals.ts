import { isDisposableEmail } from "disposable-email-domains-js";
import { AUTOMATION_USER_AGENT, FRAUD_LIMITS, PLACEHOLDER_NAMES } from "@/config/fraud";
import type { PhoneKind } from "@/modules/leads/phone";
import type { ChallengeResult } from "./challenge";
import { signal, type FraudSignal } from "./score";

export interface RequestSignalInput {
  honeypot: string | undefined;
  elapsedMs: number;
  userAgent: string | null;
  /** Two-letter country from a trusted Cloudflare header, or null when unknown/untrusted. */
  country: string | null;
  challenge: ChallengeResult;
  name: string;
  email: string;
  phoneKind: PhoneKind;
  notes: string | undefined;
}

const URL_IN_TEXT = /(https?:\/\/|www\.)\S+/i;

/**
 * Signals derivable from the request alone (no database): cheap, deterministic and unit-tested.
 * Behavioural signals that need history (velocity, identity reuse) are in history.ts.
 */
export function collectRequestSignals(input: RequestSignalInput): FraudSignal[] {
  const signals: FraudSignal[] = [];

  if (input.honeypot !== undefined && input.honeypot.trim() !== "") {
    signals.push(signal("honeypot_filled"));
  }

  if (input.userAgent === null) {
    signals.push(signal("automation_user_agent", { reason: "missing" }));
  } else if (AUTOMATION_USER_AGENT.test(input.userAgent)) {
    signals.push(signal("automation_user_agent", { reason: "known_client" }));
  }

  if (input.challenge.status === "missing") signals.push(signal("turnstile_missing"));
  if (input.challenge.status === "unavailable") signals.push(signal("turnstile_unavailable"));

  if (input.elapsedMs < FRAUD_LIMITS.tooFastMs) {
    signals.push(signal("completed_too_fast", { elapsedMs: input.elapsedMs }));
  } else if (input.elapsedMs < FRAUD_LIMITS.quickMs) {
    signals.push(signal("completed_quickly", { elapsedMs: input.elapsedMs }));
  }

  if (isDisposableEmail(input.email)) signals.push(signal("disposable_email"));
  if (input.phoneKind === "voip") signals.push(signal("voip_phone"));

  const normalisedName = input.name.trim().toLowerCase();
  if (PLACEHOLDER_NAMES.has(normalisedName) || /^(.)\1+$/u.test(normalisedName)) {
    signals.push(signal("placeholder_name"));
  }

  if (input.notes !== undefined && URL_IN_TEXT.test(input.notes)) signals.push(signal("url_in_notes"));

  if (input.country === "T1") signals.push(signal("tor_exit_node"));
  else if (input.country !== null && input.country !== "GB" && input.country !== "XX") {
    signals.push(signal("non_uk_country", { country: input.country }));
  }

  return signals;
}
