import { FRAUD_THRESHOLDS, SIGNAL_WEIGHTS, type FraudSignalCode } from "@/config/fraud";

export type FraudDecision = "accept" | "flag" | "review" | "reject";

export interface FraudSignal {
  code: FraudSignalCode;
  weight: number;
  /** Evidence for the audit trail. Must never contain personal data (no phone/email/IP). */
  detail?: Record<string, string | number | boolean>;
}

export interface FraudAssessment {
  score: number;
  decision: FraudDecision;
  signals: FraudSignal[];
}

export function signal(code: FraudSignalCode, detail?: FraudSignal["detail"]): FraudSignal {
  return { code, weight: SIGNAL_WEIGHTS[code], ...(detail && { detail }) };
}

export function decisionForScore(score: number): FraudDecision {
  if (score >= FRAUD_THRESHOLDS.reject) return "reject";
  if (score >= FRAUD_THRESHOLDS.review) return "review";
  if (score >= FRAUD_THRESHOLDS.flag) return "flag";
  return "accept";
}

/** Sums the distinct signals (each code counts once), caps at 100 and applies the thresholds. */
export function assess(signals: readonly FraudSignal[]): FraudAssessment {
  const distinct = new Map<FraudSignalCode, FraudSignal>();
  for (const item of signals) if (!distinct.has(item.code)) distinct.set(item.code, item);
  const unique = [...distinct.values()];
  const score = Math.min(100, unique.reduce((total, item) => total + item.weight, 0));
  return { score, decision: decisionForScore(score), signals: unique };
}
