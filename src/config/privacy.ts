/**
 * Data-retention design defaults. They are shown in the privacy notice and are the numbers the
 * retention job (a later stage) will enforce, so the promise and the behaviour cannot drift.
 *
 * PROPOSED values: retention periods are a legal judgement (necessity for the stated purposes,
 * limitation periods for defending claims). Have them confirmed in the legal review, then change
 * them HERE and nowhere else.
 */
export const RETENTION = {
  /** Contact details of enquiries that were passed on or are still being processed. */
  leadContactMonths: 24,
  /** Contact details of enquiries we rejected as spam or recognised as repeats. */
  rejectedLeadContactDays: 30,
  /** Proof of when and what a consumer agreed to (kept longer, minimised, to defend complaints). */
  consentEvidenceYears: 6,
  /** Technical fraud-prevention data such as IP addresses held against an enquiry. */
  fraudSignalDays: 90,
} as const;

/**
 * Why a lead was erased. A closed list (the reason is stored in the audit trail: no free text, which could hold personal data).
 * `restore_replay` is recorded by the system when erasures are re-applied after a backup restore (docs/04, docs/runbook.md).
 */
export const ERASE_REASONS = {
  consumer_request: "The consumer asked for their data to be erased",
  test_data: "Test or junk data",
} as const;
export type EraseReason = keyof typeof ERASE_REASONS;
export const ERASE_REASON_CODES = Object.keys(ERASE_REASONS) as EraseReason[];

/**
 * Used ONLY when PRIVACY_HASH_KEY is unset, which the environment validation permits only outside staging/production. It is public
 * (it is in this repository), so suppression hashes made with it protect nothing: real deployments must set their own secret key.
 */
export const DEV_PRIVACY_HASH_KEY = "dev-only-privacy-hash-key-public-do-not-use-in-production";
