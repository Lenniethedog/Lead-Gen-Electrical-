import type { Ownership, PropertyType, Urgency } from "@/config/lead-options";
import { isValidScope, type ServiceSlug } from "@/config/verticals/electrical";
import { normalisePostcode } from "@/modules/postcodes/normalise";

/**
 * Pure state machine for the multi-step form (no React, no browser APIs), so every rule about
 * steps, resets and server-error routing is unit-tested rather than buried in components.
 */

export const STEPS = ["service", "postcode", "property", "scope", "urgency", "contact"] as const;
export type StepId = (typeof STEPS)[number];
export const LAST_STEP = STEPS.length - 1;

export interface Coverage {
  /** The normalised postcode the server confirmed we cover. */
  postcode: string;
  areaName: string;
}

export interface FormValues {
  service: ServiceSlug | null;
  /** Exactly what the user typed. */
  postcode: string;
  coverage: Coverage | null;
  propertyType: PropertyType | null;
  ownership: Ownership | null;
  scope: string | null;
  urgency: Urgency | null;
  name: string;
  phone: string;
  email: string;
  notes: string;
}

export type FieldErrors = Partial<Record<keyof FormValues | "consent", string>>;
export type Status = "editing" | "submitting" | "done";

export interface FormState {
  step: number;
  values: FormValues;
  status: Status;
  reference: string | null;
  /** Form-level problem (network, server, rate limit), distinct from per-field errors. */
  formError: string | null;
  fieldErrors: FieldErrors;
  /** One key per submission attempt-series: retries reuse it, a new enquiry gets a new one. */
  idempotencyKey: string;
  /** When the form first rendered (epoch ms): a weak anti-bot timing signal. */
  startedAt: number;
}

export const EMPTY_VALUES: FormValues = {
  service: null,
  postcode: "",
  coverage: null,
  propertyType: null,
  ownership: null,
  scope: null,
  urgency: null,
  name: "",
  phone: "",
  email: "",
  notes: "",
};

export function initialState(idempotencyKey: string, now: number): FormState {
  return {
    step: 0,
    values: EMPTY_VALUES,
    status: "editing",
    reference: null,
    formError: null,
    fieldErrors: {},
    idempotencyKey,
    startedAt: now,
  };
}

export type Action =
  | { type: "patch"; patch: Partial<FormValues> }
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; step: number }
  | { type: "restore"; step: number; values: FormValues; idempotencyKey: string; startedAt: number }
  | { type: "rekey"; idempotencyKey: string }
  | { type: "submit_started" }
  | { type: "submit_succeeded"; reference: string }
  | { type: "submit_failed"; formError: string | null; fieldErrors: FieldErrors; goToStep: number | null }
  | { type: "reset"; idempotencyKey: string; now: number };

const clamp = (step: number) => Math.min(LAST_STEP, Math.max(0, step));

export function reducer(state: FormState, action: Action): FormState {
  switch (action.type) {
    case "patch": {
      const values = { ...state.values, ...action.patch };
      // Scope options belong to a service: a different service invalidates the old answer.
      if (action.patch.service !== undefined && action.patch.service !== state.values.service) values.scope = null;
      // Editing the postcode invalidates a previous coverage confirmation for the OLD postcode.
      if (action.patch.postcode !== undefined && values.coverage && !samePostcode(action.patch.postcode, values.coverage.postcode)) {
        values.coverage = null;
      }
      // Fixing a field clears its server-reported error.
      const fieldErrors = { ...state.fieldErrors };
      for (const key of Object.keys(action.patch) as Array<keyof FormValues>) delete fieldErrors[key];
      return { ...state, values, fieldErrors, formError: null };
    }
    case "next":
      return { ...state, step: clamp(state.step + 1), formError: null };
    case "back":
      return { ...state, step: clamp(state.step - 1), formError: null };
    case "goto":
      return { ...state, step: clamp(action.step), formError: null };
    case "restore":
      return {
        ...state,
        step: clamp(action.step),
        values: action.values,
        idempotencyKey: action.idempotencyKey,
        startedAt: action.startedAt,
      };
    case "rekey":
      return { ...state, idempotencyKey: action.idempotencyKey };
    case "submit_started":
      return { ...state, status: "submitting", formError: null, fieldErrors: {} };
    case "submit_succeeded":
      return { ...state, status: "done", reference: action.reference, formError: null, fieldErrors: {} };
    case "submit_failed":
      return {
        ...state,
        status: "editing",
        formError: action.formError,
        fieldErrors: action.fieldErrors,
        step: action.goToStep === null ? state.step : clamp(action.goToStep),
      };
    case "reset":
      return initialState(action.idempotencyKey, action.now);
  }
}

function samePostcode(typed: string, confirmed: string): boolean {
  return typed.toUpperCase().replace(/[^A-Z0-9]/g, "") === confirmed.replace(/[^A-Z0-9]/g, "");
}

/** Server field path (wire format) -> form field. */
const SERVER_FIELD_TO_FORM_FIELD: Record<string, keyof FormValues | "consent"> = {
  service: "service",
  postcode: "postcode",
  propertyType: "propertyType",
  ownership: "ownership",
  scope: "scope",
  urgency: "urgency",
  "contact.name": "name",
  "contact.phone": "phone",
  "contact.email": "email",
  "contact.notes": "notes",
  "consent.accepted": "consent",
};

export function stepForField(field: keyof FormValues | "consent"): number {
  switch (field) {
    case "service":
      return 0;
    case "postcode":
    case "coverage":
      return 1;
    case "propertyType":
    case "ownership":
      return 2;
    case "scope":
      return 3;
    case "urgency":
      return 4;
    default:
      return 5;
  }
}

/**
 * Translates a server 422 into per-field messages plus the earliest step that needs attention,
 * so the user is taken to the thing to fix instead of a generic "something went wrong".
 */
export function routeServerErrors(serverFields: Record<string, string>): { fieldErrors: FieldErrors; goToStep: number | null } {
  const fieldErrors: FieldErrors = {};
  let goToStep: number | null = null;
  for (const [path, message] of Object.entries(serverFields)) {
    const field = SERVER_FIELD_TO_FORM_FIELD[path];
    if (!field) continue;
    fieldErrors[field] = message;
    const step = stepForField(field);
    if (goToStep === null || step < goToStep) goToStep = step;
  }
  return { fieldErrors, goToStep };
}

/**
 * The first step whose answer is missing or unusable, or null when everything needed to submit is
 * present. Guards against a restored/corrupted session reaching the submit button half-empty.
 */
export function firstIncompleteStep(values: FormValues): number | null {
  if (values.service === null) return 0;
  if (normalisePostcode(values.postcode) === null) return 1;
  if (values.propertyType === null || values.ownership === null) return 2;
  if (values.scope === null || !isValidScope(values.service, values.scope)) return 3;
  if (values.urgency === null) return 4;
  return null;
}
