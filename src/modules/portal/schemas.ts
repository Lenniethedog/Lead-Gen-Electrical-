import * as z from "zod";
import { CONTACT_OUTCOME_CODES, OUTCOMES_WITH_VALUE, type ContactOutcome } from "@/config/client-dashboard";
import { parseUkPhone } from "@/modules/leads/phone";

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

// ------------------------------------------------------------------------------------------------
// Notification settings and change requests (slice 5)
// ------------------------------------------------------------------------------------------------

const ticked = (value: string | undefined) => value === "on" || value === "true" || value === "1";

export interface NotificationInput {
  email: boolean;
  sms: boolean;
  contactEmail: string;
  /** E.164, or null to remove the number. */
  contactPhone: string | null;
}

export type ParsedNotification = { ok: true; value: NotificationInput } | { ok: false; errors: Partial<Record<"contactEmail" | "contactPhone" | "channels", string>> };

/** What a business may change about how it is told. The address and number leads are sent to are the sensitive part; the role rules for them are in the service. */
export function parseNotificationSettings(fields: Record<string, string | undefined>): ParsedNotification {
  const errors: Partial<Record<"contactEmail" | "contactPhone" | "channels", string>> = {};
  const email = z.string().trim().toLowerCase().max(254).pipe(z.email()).safeParse(fields.contactEmail ?? "");
  if (!email.success) errors.contactEmail = "Enter a valid email address";
  let contactPhone: string | null = null;
  const rawPhone = (fields.contactPhone ?? "").trim();
  if (rawPhone !== "") {
    const parsed = parseUkPhone(rawPhone);
    if (parsed.ok) contactPhone = parsed.value.e164;
    else errors.contactPhone = parsed.message;
  }
  const wantsEmail = ticked(fields.notifyEmail);
  const wantsSms = ticked(fields.notifySms);
  if (wantsSms && contactPhone === null && !errors.contactPhone) errors.contactPhone = "Add a mobile number to get text messages";
  if (Object.keys(errors).length > 0 || !email.success) return { ok: false, errors };
  return { ok: true, value: { email: wantsEmail, sms: wantsSms, contactEmail: email.data, contactPhone } };
}

export const CHANGE_REQUEST_KINDS = { coverage: "The area I cover", services: "The work I do", other: "Something else" } as const;
export type ChangeRequestKind = keyof typeof CHANGE_REQUEST_KINDS;

export type ParsedChangeRequest = { ok: true; value: { kind: ChangeRequestKind; message: string } } | { ok: false; errors: Partial<Record<"kind" | "message", string>> };

export function parseChangeRequest(fields: Record<string, string | undefined>): ParsedChangeRequest {
  const errors: Partial<Record<"kind" | "message", string>> = {};
  const kind = (Object.keys(CHANGE_REQUEST_KINDS) as ChangeRequestKind[]).find((code) => code === fields.kind);
  if (!kind) errors.kind = "Choose what you want changed";
  const message = (fields.message ?? "").trim();
  if (message.length < 5) errors.message = "Tell us what you would like changed";
  if (message.length > 1000) errors.message = "Keep it under 1,000 characters";
  if (Object.keys(errors).length > 0 || !kind) return { ok: false, errors };
  return { ok: true, value: { kind, message } };
}
