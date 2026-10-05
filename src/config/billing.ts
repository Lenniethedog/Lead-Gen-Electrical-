/**
 * Credit and charging vocabulary (stage 6, docs/00 D50-D54). Reasons are a CLOSED list: a reason is stored in the money log and the audit
 * trail, and free text would let a person's details end up there.
 */
export const BILLING_MODES = {
  invoice: "Invoiced: nothing is paid from credit; staff invoice from the recorded charges",
  prepaid: "Prepaid: each lead is paid for from credit when it is assigned",
} as const;
export type BillingMode = keyof typeof BILLING_MODES;
export const BILLING_MODE_CODES = Object.keys(BILLING_MODES) as BillingMode[];

/** What staff can do to a business's credit. `top_up` is payment received outside the system until payments arrive (stage 7). */
export const CREDIT_KINDS = {
  top_up: { label: "Payment received", reasons: { bank_transfer: "Bank transfer received" }, signed: false },
  grant: { label: "Free credit", reasons: { onboarding_credit: "Welcome credit", goodwill: "Goodwill", compensation: "Compensation for a problem" }, signed: false },
  adjustment: { label: "Correction", reasons: { error_correction: "Correcting a mistake", other: "Another reason" }, signed: true },
} as const;
export type CreditKind = keyof typeof CREDIT_KINDS;
export const CREDIT_KIND_CODES = Object.keys(CREDIT_KINDS) as CreditKind[];

/** One posting, either way: a typo guard, not a business rule. */
export const MAX_CREDIT_POSTING_PENCE = 1_000_000;

/** How a ledger entry reads to a person. `reason` is a code; unknown codes fall back to the entry type. */
export const LEDGER_TYPE_LABELS = {
  top_up: "Payment received",
  grant: "Free credit",
  lead_charge: "Lead charge",
  refund: "Lead refunded",
  adjustment: "Correction",
  expiry: "Credit expired",
} as const;
export type LedgerEntryType = keyof typeof LEDGER_TYPE_LABELS;

/** What each money problem means (the reconciliation view's codes), for the admin page. */
export const MONEY_PROBLEM_TEXT: Record<string, string> = {
  wallet_differs_from_ledger_sum: "A balance is not the sum of its ledger",
  wallet_differs_from_last_balance_after: "A balance is not the last balance in its ledger",
  ledger_without_wallet: "A ledger has no wallet",
  prepaid_charge_without_matching_ledger_entry: "A prepaid charge has no matching ledger entry",
  reversed_charge_without_matching_refund: "A reversed charge has no matching refund",
  charge_entry_without_charge: "A ledger charge belongs to no charge",
  charge_differs_from_assignment_price: "A charge is not the assignment's price",
  live_assignment_without_posted_charge: "A lead a business holds has no live charge",
  ended_assignment_with_posted_charge: "A lead that ended is still being charged for",
};
