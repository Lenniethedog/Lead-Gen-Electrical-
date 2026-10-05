import * as z from "zod";
import { parseUkPhone } from "@/modules/leads/phone";
import { normalisePostcode } from "@/modules/postcodes/normalise";

/**
 * Validation for the client forms. Pure (no database), so it is unit-tested directly; the server re-validates everything a
 * form posts, since a server action is reachable by a hand-written request.
 */
export type FieldErrors = Record<string, string>;

/** What a form shows after a failed submission: the problems, and what was typed so nothing has to be retyped. */
export interface FormState {
  errors?: FieldErrors;
  message?: string;
  values?: Record<string, string>;
}
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: FieldErrors };

const text = (max: number) => z.string().trim().max(max, `At most ${max} characters`);
/** An empty form field means "not provided". */
const optionalText = (max: number) => text(max).transform((value) => (value === "" ? undefined : value)).optional();
/** A HTML checkbox posts "on" when ticked and nothing at all when not. */
const checkbox = z.string().optional().transform((value) => value === "on" || value === "true" || value === "1");

export const CLIENT_STATUSES = ["prospect", "active", "paused", "suspended", "churned"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/** Why a client's status changed. A closed list (no free text: it is stored in the audit trail). */
export const CLIENT_STATUS_REASONS = {
  onboarded: "Agreed terms and ready to receive leads",
  paused_by_client: "The business asked to pause",
  quality_concerns: "Concerns about how they treat leads",
  non_payment: "Not paying",
  ended: "Relationship ended",
  other: "Another reason",
} as const;
export type ClientStatusReason = keyof typeof CLIENT_STATUS_REASONS;
/** Moving a client away from `active` (or reviving a churned one) must be explained. */
export const statusNeedsReason = (to: ClientStatus): boolean => to === "paused" || to === "suspended" || to === "churned";

const clientShape = z.object({
  name: text(120).min(1, "Enter the business name"),
  legalName: optionalText(200),
  companyNumber: optionalText(20),
  contactName: optionalText(100),
  contactEmail: z.string().trim().toLowerCase().max(254, "That email address is too long").pipe(z.email("Enter a valid email address")),
  contactPhone: optionalText(30),
  acceptsExclusive: checkbox,
  acceptsShared: checkbox,
  notes: optionalText(2000),
});

export interface ClientInput {
  name: string;
  legalName: string | undefined;
  companyNumber: string | undefined;
  contactName: string | undefined;
  contactEmail: string;
  /** E.164 */
  contactPhone: string | undefined;
  acceptsExclusive: boolean;
  acceptsShared: boolean;
  notes: string | undefined;
}

function fieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) errors[String(issue.path[0] ?? "form")] ??= issue.message;
  return errors;
}

export function parseClientInput(fields: Record<string, string | undefined>): Parsed<ClientInput> {
  const result = clientShape.safeParse(fields);
  const errors = result.success ? {} : fieldErrors(result.error);

  // These are checked from the raw fields, so every problem is reported at once rather than one per submission.
  let phone: string | undefined;
  const rawPhone = (fields.contactPhone ?? "").trim();
  if (rawPhone !== "") {
    const parsed = parseUkPhone(rawPhone);
    if (parsed.ok) phone = parsed.value.e164;
    else errors.contactPhone = parsed.message;
  }
  const ticked = (value: string | undefined) => value === "on" || value === "true" || value === "1";
  if (!ticked(fields.acceptsExclusive) && !ticked(fields.acceptsShared)) errors.acceptsExclusive = "Choose at least one: exclusive or shared leads";

  if (!result.success || Object.keys(errors).length > 0) return { ok: false, errors };
  const data = result.data;
  return {
    ok: true,
    value: {
      name: data.name,
      legalName: data.legalName,
      companyNumber: data.companyNumber,
      contactName: data.contactName,
      contactEmail: data.contactEmail,
      contactPhone: phone,
      acceptsExclusive: data.acceptsExclusive,
      acceptsShared: data.acceptsShared,
      notes: data.notes,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Coverage rules
// ---------------------------------------------------------------------------------------------------
export const COVERAGE_KINDS = ["outward", "sector", "postcode_prefix", "area", "radius"] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];
export const COVERAGE_MODES = ["include", "exclude"] as const;
export type CoverageMode = (typeof COVERAGE_MODES)[number];

/** 1 mile = 1,609.344 m. The database stores metres (500 m to 100 km); operators think in miles. */
export const METRES_PER_MILE = 1609.344;
export const MAX_RADIUS_MILES = 60;

export type CoverageRuleInput =
  | { mode: CoverageMode; kind: "outward"; outward: string }
  | { mode: CoverageMode; kind: "sector"; sector: string }
  | { mode: CoverageMode; kind: "postcode_prefix"; postcodePrefix: string }
  | { mode: CoverageMode; kind: "area"; serviceAreaSlug: string }
  | { mode: CoverageMode; kind: "radius"; centerPostcode: string; radiusMetres: number };

const OUTWARD = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
const SECTOR = /^([A-Z]{1,2}[0-9][A-Z0-9]?) ?([0-9])$/;
const PREFIX = /^[A-Z]{1,2}[0-9A-Z ]{0,6}$/;

const squash = (value: string | undefined) => (value ?? "").toUpperCase().replace(/\s+/g, " ").trim();

export function parseCoverageRule(fields: Record<string, string | undefined>): Parsed<CoverageRuleInput> {
  const mode = fields.mode === "exclude" ? "exclude" : fields.mode === "include" ? "include" : undefined;
  const kind = COVERAGE_KINDS.find((candidate) => candidate === fields.kind);
  if (!mode) return { ok: false, errors: { mode: "Choose include or exclude" } };
  if (!kind) return { ok: false, errors: { kind: "Choose the kind of rule" } };

  switch (kind) {
    case "outward": {
      const outward = squash(fields.outward);
      if (!OUTWARD.test(outward)) return { ok: false, errors: { outward: "Enter a postcode district such as BR6 or TN13" } };
      return { ok: true, value: { mode, kind, outward } };
    }
    case "sector": {
      const match = SECTOR.exec(squash(fields.sector));
      if (!match) return { ok: false, errors: { sector: "Enter a postcode sector such as BR6 0" } };
      return { ok: true, value: { mode, kind, sector: `${match[1]} ${match[2]}` } };
    }
    case "postcode_prefix": {
      const postcodePrefix = squash(fields.postcodePrefix);
      if (!PREFIX.test(postcodePrefix)) return { ok: false, errors: { postcodePrefix: "Enter the start of a postcode, such as BR or BR6 0" } };
      return { ok: true, value: { mode, kind, postcodePrefix } };
    }
    case "area": {
      const serviceAreaSlug = (fields.serviceAreaSlug ?? "").trim();
      if (!/^[a-z][a-z0-9_]*$/.test(serviceAreaSlug)) return { ok: false, errors: { serviceAreaSlug: "Choose an area" } };
      return { ok: true, value: { mode, kind, serviceAreaSlug } };
    }
    case "radius": {
      const errors: FieldErrors = {};
      const centerPostcode = normalisePostcode(fields.centerPostcode ?? "");
      if (!centerPostcode) errors.centerPostcode = "Enter a full postcode for the centre, such as BR6 0AA";
      const miles = Number(fields.radiusMiles);
      if (!Number.isFinite(miles) || miles < 1 || miles > MAX_RADIUS_MILES) errors.radiusMiles = `Enter a radius from 1 to ${MAX_RADIUS_MILES} miles`;
      if (Object.keys(errors).length > 0 || !centerPostcode) return { ok: false, errors };
      return { ok: true, value: { mode, kind, centerPostcode, radiusMetres: Math.round(miles * METRES_PER_MILE) } };
    }
  }
}

/** Human wording for a rule, e.g. "Within 10 miles of BR6 0AA". `areaName` is looked up by the caller for `area` rules. */
export function describeRule(
  rule: { kind: CoverageKind; outward?: string | null; sector?: string | null; postcode_prefix?: string | null; center_postcode?: string | null; radius_m?: number | null },
  areaName?: string | null,
): string {
  switch (rule.kind) {
    case "outward":
      return `Postcode district ${rule.outward}`;
    case "sector":
      return `Postcode sector ${rule.sector}`;
    case "postcode_prefix":
      return `Postcodes starting "${rule.postcode_prefix}"`;
    case "area":
      return `Area: ${areaName ?? "unknown"}`;
    case "radius": {
      const miles = Math.round(((rule.radius_m ?? 0) / METRES_PER_MILE) * 10) / 10;
      return `Within ${miles} mile${miles === 1 ? "" : "s"} of ${rule.center_postcode}`;
    }
  }
}

export const clientIdSchema = z.uuid();
export const serviceSlugsSchema = z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).max(50);
