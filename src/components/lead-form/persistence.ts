import * as z from "zod";
import { ownershipSchema, propertyTypeSchema, serviceSchema, urgencySchema } from "@/modules/leads/schemas/steps";
import { LAST_STEP, type FormValues } from "./state";

/**
 * Keeps the user's progress across reloads and accidental navigation.
 *
 * Deliberately sessionStorage (cleared when the tab closes) rather than localStorage: it is
 * enough for "I refreshed" and "I opened the privacy notice and came back", it does not leave
 * personal data on a shared computer, and storing form progress the user asked for sits
 * comfortably within the "strictly necessary" storage exemption (have this confirmed in the legal
 * review). Consent is NEVER persisted: it must be given afresh at the moment of submission.
 */

const STORAGE_KEY = "leadform.v1";
const TTL_MS = 2 * 60 * 60 * 1000;

const persistedSchema = z.object({
  v: z.literal(1),
  savedAt: z.number(),
  step: z.number().int().min(0).max(LAST_STEP),
  idempotencyKey: z.string().regex(/^[0-9a-f-]{36}$/i),
  startedAt: z.number(),
  values: z.object({
    service: serviceSchema.nullable(),
    postcode: z.string().max(20),
    coverage: z.object({ postcode: z.string().max(10), areaName: z.string().max(100) }).nullable(),
    propertyType: propertyTypeSchema.nullable(),
    ownership: ownershipSchema.nullable(),
    scope: z.string().max(60).nullable(),
    urgency: urgencySchema.nullable(),
    name: z.string().max(200),
    phone: z.string().max(40),
    email: z.string().max(300),
    notes: z.string().max(2000),
  }),
});

export interface PersistedForm {
  step: number;
  values: FormValues;
  idempotencyKey: string;
  startedAt: number;
}

/** Storage can be missing, blocked or full (private mode, policies): never let that break the form. */
export function getSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function loadPersisted(storage: Storage | null, now: number): PersistedForm | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = persistedSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || now - parsed.data.savedAt > TTL_MS || parsed.data.savedAt > now + 60_000) {
      storage.removeItem(STORAGE_KEY);
      return null;
    }
    const { step, values, idempotencyKey, startedAt } = parsed.data;
    return { step, values, idempotencyKey, startedAt };
  } catch {
    return null;
  }
}

export function savePersisted(storage: Storage | null, form: PersistedForm, now: number): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, savedAt: now, ...form }));
  } catch {
    // Quota exceeded or storage disabled: progress simply is not saved.
  }
}

export function clearPersisted(storage: Storage | null): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
