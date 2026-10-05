import { CONTACT_OUTCOME_CODES, OUTCOMES_WITH_VALUE, type ContactOutcome } from "@/config/client-dashboard";

/** What a business types about a call. Pure parsing: the form gives instant feedback and the server re-validates everything. */

export interface ContactAttemptInput {
  outcome: ContactOutcome;
  note: string | null;
  /** Pence. Only for a quote or a job won. */
  jobValuePence: number | null;
}

export const MAX_JOB_VALUE_PENCE = 100_000_000; // £1,000,000: a typo guard

/** "1500", "1,500", "£1,500.50" -> pence. No exponents, at most 2 decimals, up to a million pounds. */
export function parseJobValue(input: string | undefined): number | undefined {
  const match = /^£?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec((input ?? "").trim());
  if (!match) return undefined;
  const pence = Number(match[1]!.replace(/,/g, "")) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return pence <= MAX_JOB_VALUE_PENCE ? pence : undefined;
}

export type ParsedAttempt = { ok: true; value: ContactAttemptInput } | { ok: false; errors: Partial<Record<"outcome" | "note" | "jobValue", string>> };

export function parseContactAttempt(fields: Record<string, string | undefined>): ParsedAttempt {
  const errors: Partial<Record<"outcome" | "note" | "jobValue", string>> = {};
  const outcome = CONTACT_OUTCOME_CODES.find((code) => code === fields.outcome);
  if (!outcome) errors.outcome = "Choose what happened";
  const note = (fields.note ?? "").trim();
  if (note.length > 1000) errors.note = "Keep the note under 1,000 characters";

  const rawValue = (fields.jobValue ?? "").trim();
  let jobValuePence: number | null = null;
  if (rawValue !== "") {
    const pence = parseJobValue(rawValue);
    if (pence === undefined) errors.jobValue = "Enter an amount in pounds, like 1,500 or 480.50";
    else if (outcome && !OUTCOMES_WITH_VALUE.includes(outcome)) errors.jobValue = "An amount only goes with a quote or a job won";
    else jobValuePence = pence;
  }
  if (Object.keys(errors).length > 0 || !outcome) return { ok: false, errors };
  return { ok: true, value: { outcome, note: note === "" ? null : note, jobValuePence } };
}
