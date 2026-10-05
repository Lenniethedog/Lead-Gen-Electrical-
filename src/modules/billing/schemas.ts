import { CREDIT_KINDS, CREDIT_KIND_CODES, MAX_CREDIT_POSTING_PENCE, type CreditKind } from "@/config/billing";

/** What staff type to add or remove credit. Pure parsing: the form gives instant feedback and the server re-validates everything. */

/** "250", "1,250.50", "£250", and (corrections only) "-40" -> pence. No exponents, at most 2 decimals. */
export function parseCreditAmount(input: string | undefined, allowNegative: boolean): number | undefined {
  const match = /^(-)?£?\s*(\d{1,3}(?:,\d{3})+|\d{1,7})(?:\.(\d{1,2}))?$/.exec((input ?? "").trim());
  if (!match) return undefined;
  if (match[1] && !allowNegative) return undefined;
  const pence = Number(match[2]!.replace(/,/g, "")) * 100 + Number((match[3] ?? "").padEnd(2, "0") || "0");
  if (pence === 0 || pence > MAX_CREDIT_POSTING_PENCE) return undefined;
  return match[1] ? -pence : pence;
}

export interface CreditPostingInput {
  kind: CreditKind;
  reason: string;
  amountPence: number;
}

export type ParsedPosting = { ok: true; value: CreditPostingInput } | { ok: false; errors: Partial<Record<"kind" | "reason" | "amount", string>> };

export function parseCreditPosting(fields: Record<string, string | undefined>): ParsedPosting {
  const errors: Partial<Record<"kind" | "reason" | "amount", string>> = {};
  const kind = CREDIT_KIND_CODES.find((code) => code === fields.kind);
  if (!kind) errors.kind = "Choose what kind of credit this is";
  const reasons = kind ? (Object.keys(CREDIT_KINDS[kind].reasons) as string[]) : [];
  const reason = reasons.find((code) => code === fields.reason);
  if (kind && !reason) errors.reason = "Choose a reason";
  const amountPence = kind ? parseCreditAmount(fields.amount, CREDIT_KINDS[kind].signed) : undefined;
  if (kind && amountPence === undefined) errors.amount = CREDIT_KINDS[kind].signed ? "Enter an amount in pounds, like 25 or -40.50 (not zero, at most £10,000)" : "Enter an amount in pounds, like 250 or 1,250.50 (more than zero, at most £10,000)";
  if (Object.keys(errors).length > 0 || !kind || !reason || amountPence === undefined) return { ok: false, errors };
  return { ok: true, value: { kind, reason, amountPence } };
}
