import type { FieldErrors, Parsed } from "./schemas";

/**
 * What a business asked for about WHEN and HOW OFTEN it receives automatic leads (stage 4). Pure parsing, shared by the form and the
 * server: the browser gives instant feedback, the server re-validates everything.
 */

/** Why a business is paused. A closed list: the reason is stored with the pause and in the audit trail, so no free text. */
export const PAUSE_REASONS = {
  holiday: "Holiday or time away",
  at_capacity: "Diary is full",
  other: "Another reason",
} as const;
export type PauseReason = keyof typeof PAUSE_REASONS;
export const PAUSE_REASON_CODES = Object.keys(PAUSE_REASONS) as PauseReason[];

export const WEEKDAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
  { value: 0, label: "Sunday" },
] as const;

// ------------------------------------------------------------------------------------------------
// Priority, weight and caps
// ------------------------------------------------------------------------------------------------

export interface RoutingPreferencesInput {
  /** Lower goes first. */
  priority: number;
  /** 0 = manual only: never routed automatically. */
  weight: number;
  dailyLeadCap: number | null;
  monthlyLeadCap: number | null;
  /** The most leads it will hold UNANSWERED (not yet accepted or declined) at once. Null = no limit. */
  maxOpenLeads: number | null;
}

const wholeNumber = (raw: string | undefined): number | undefined => {
  const text = (raw ?? "").trim();
  return /^\d{1,6}$/.test(text) ? Number(text) : undefined;
};

export function parseRoutingPreferences(fields: Record<string, string | undefined>): Parsed<RoutingPreferencesInput> {
  const errors: FieldErrors = {};

  const priority = wholeNumber(fields.priority);
  if (priority === undefined || priority > 1000) errors.priority = "Enter a whole number from 0 to 1000 (lower goes first)";
  const weight = wholeNumber(fields.weight);
  if (weight === undefined || weight > 100) errors.weight = "Enter a whole number from 0 to 100 (0 means manual only)";

  const optionalCap = (field: "dailyLeadCap" | "monthlyLeadCap" | "maxOpenLeads", max: number, label: string): number | null | undefined => {
    const raw = (fields[field] ?? "").trim();
    if (raw === "") return null;
    const value = wholeNumber(raw);
    if (value === undefined || value < 1 || value > max) {
      errors[field] = `Enter a whole number from 1 to ${max}, or leave it empty for no ${label} limit`;
      return undefined;
    }
    return value;
  };
  const dailyLeadCap = optionalCap("dailyLeadCap", 1000, "daily");
  const monthlyLeadCap = optionalCap("monthlyLeadCap", 10_000, "monthly");
  const maxOpenLeads = optionalCap("maxOpenLeads", 100, "unanswered-leads");
  if (typeof dailyLeadCap === "number" && typeof monthlyLeadCap === "number" && dailyLeadCap > monthlyLeadCap) {
    errors.monthlyLeadCap = "The monthly limit cannot be lower than the daily limit";
  }

  if (Object.keys(errors).length > 0 || priority === undefined || weight === undefined || dailyLeadCap === undefined || monthlyLeadCap === undefined || maxOpenLeads === undefined) return { ok: false, errors };
  return { ok: true, value: { priority, weight, dailyLeadCap, monthlyLeadCap, maxOpenLeads } };
}

// ------------------------------------------------------------------------------------------------
// Working hours
// ------------------------------------------------------------------------------------------------

export interface WorkingWindowInput {
  /** 0 = Sunday. */
  weekday: number;
  /** "HH:MM", 24 hour. */
  opens: string;
  closes: string;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * `limitHours` unticked means no restriction at all (every window is removed). Ticked, each day with BOTH times is an open day and a day with
 * neither is closed; a day with only one is an error the form can point at. At least one open day is required (a restriction that is
 * never open would silently turn the business off).
 */
export function parseWorkingHours(fields: Record<string, string | undefined>): Parsed<{ windows: WorkingWindowInput[] }> {
  if (fields.limitHours !== "on") return { ok: true, value: { windows: [] } };
  const errors: FieldErrors = {};
  const windows: WorkingWindowInput[] = [];

  for (const { value: weekday, label } of WEEKDAYS) {
    const opens = (fields[`opens_${weekday}`] ?? "").trim();
    const closes = (fields[`closes_${weekday}`] ?? "").trim();
    if (opens === "" && closes === "") continue;
    if (opens === "" || closes === "") {
      errors[`opens_${weekday}`] = `${label}: enter both an opening and a closing time, or leave both empty to be closed`;
      continue;
    }
    if (!TIME.test(opens)) errors[`opens_${weekday}`] = `${label}: enter the opening time as hours and minutes, like 08:00`;
    else if (!TIME.test(closes)) errors[`closes_${weekday}`] = `${label}: enter the closing time as hours and minutes, like 17:30`;
    else if (closes <= opens) errors[`closes_${weekday}`] = `${label}: it must close after it opens`;
    else windows.push({ weekday, opens, closes });
  }
  if (Object.keys(errors).length === 0 && windows.length === 0) {
    errors.limitHours = "Choose at least one open day, or untick \"Only send leads during working hours\"";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { windows } };
}

// ------------------------------------------------------------------------------------------------
// Pauses
// ------------------------------------------------------------------------------------------------

export interface PauseInput {
  /** The business's own local time, "YYYY-MM-DDTHH:MM" (what a datetime-local input gives). The database converts it with the business's time zone. */
  from: string;
  until: string;
  reason: PauseReason;
}

const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;

export function parsePause(fields: Record<string, string | undefined>): Parsed<PauseInput> {
  const errors: FieldErrors = {};
  const from = (fields.from ?? "").trim();
  const until = (fields.until ?? "").trim();
  const reason = PAUSE_REASON_CODES.find((code) => code === fields.reason);

  if (!LOCAL_DATETIME.test(from) || Number.isNaN(Date.parse(`${from}:00Z`))) errors.from = "Enter the date and time the pause starts";
  if (!LOCAL_DATETIME.test(until) || Number.isNaN(Date.parse(`${until}:00Z`))) errors.until = "Enter the date and time the pause ends";
  if (!errors.from && !errors.until && until <= from) errors.until = "The pause must end after it starts";
  if (!reason) errors.reason = "Choose a reason";

  if (Object.keys(errors).length > 0 || !reason) return { ok: false, errors };
  return { ok: true, value: { from, until, reason } };
}
