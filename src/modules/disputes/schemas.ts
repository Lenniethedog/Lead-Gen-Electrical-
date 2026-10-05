import { DISPUTE_DECISION_REASONS, DISPUTE_REASON_CODES, DISPUTE_RESOLUTION_CODES, type DisputeDecisionReason, type DisputeReason, type DisputeResolution } from "@/config/disputes";

/** What a business types when it reports a problem, and what staff choose when they decide. Pure parsing, shared by the form and the server. */

export interface DisputeInput {
  reason: DisputeReason;
  description: string | null;
}

export type ParsedDispute = { ok: true; value: DisputeInput } | { ok: false; errors: Partial<Record<"reason" | "description", string>> };

export function parseDispute(fields: Record<string, string | undefined>): ParsedDispute {
  const errors: Partial<Record<"reason" | "description", string>> = {};
  const reason = DISPUTE_REASON_CODES.find((code) => code === fields.reason);
  if (!reason) errors.reason = "Choose what is wrong with it";
  const description = (fields.description ?? "").trim();
  if (description.length > 2000) errors.description = "Keep it under 2,000 characters";
  if (reason === "other" && description.length < 5) errors.description = "Tell us what is wrong, in a few words";
  if (Object.keys(errors).length > 0 || !reason) return { ok: false, errors };
  return { ok: true, value: { reason, description: description === "" ? null : description } };
}

export type Decision =
  | { outcome: "uphold"; resolution: DisputeResolution; reason: DisputeDecisionReason }
  | { outcome: "reject"; reason: DisputeDecisionReason };

export type ParsedDecision = { ok: true; value: Decision } | { ok: false; error: "invalid_outcome" | "invalid_resolution" | "invalid_decision_reason" };

/** The reason must belong to the outcome chosen (an "upheld" reason cannot justify a rejection). */
export function parseDecision(fields: Record<string, string | undefined>): ParsedDecision {
  const outcome = fields.outcome === "uphold" || fields.outcome === "reject" ? fields.outcome : undefined;
  if (!outcome) return { ok: false, error: "invalid_outcome" };
  const reason = (Object.keys(DISPUTE_DECISION_REASONS) as DisputeDecisionReason[]).find((code) => code === fields.decisionReason);
  if (!reason || DISPUTE_DECISION_REASONS[reason].outcome !== (outcome === "uphold" ? "upheld" : "rejected")) return { ok: false, error: "invalid_decision_reason" };
  if (outcome === "reject") return { ok: true, value: { outcome, reason } };
  const resolution = DISPUTE_RESOLUTION_CODES.find((code) => code === fields.resolution);
  if (!resolution) return { ok: false, error: "invalid_resolution" };
  return { ok: true, value: { outcome, resolution, reason } };
}
