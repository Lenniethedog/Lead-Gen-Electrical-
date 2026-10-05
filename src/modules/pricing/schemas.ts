import { URGENCY_VALUES, type Urgency } from "@/config/lead-options";
import type { Parsed } from "@/modules/clients/schemas";

/** Prices are integer pence everywhere (docs/02). The form takes pounds. */
export const MAX_PRICE_PENCE = 100_000; // £1,000 per lead: a typo guard, not a business rule

export interface PricingRuleInput {
  /** null = any service */
  serviceSlug: string | null;
  /** null = anywhere */
  serviceAreaSlug: string | null;
  /** null = any urgency */
  urgency: Urgency | null;
  saleType: "exclusive" | "shared";
  pricePence: number;
}

/** "35", "35.5", "35.50", "£35" -> pence. Rejects anything else (no thousands separators, no exponents, at most 2 decimals). */
export function parsePoundsToPence(input: string | undefined): number | undefined {
  const match = /^£?\s*(\d{1,4})(?:\.(\d{1,2}))?$/.exec((input ?? "").trim());
  if (!match) return undefined;
  const pence = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return pence <= MAX_PRICE_PENCE ? pence : undefined;
}

const SLUG = /^[a-z][a-z0-9_]*$/;

export function parsePricingRule(fields: Record<string, string | undefined>): Parsed<PricingRuleInput> {
  const errors: Record<string, string> = {};
  const serviceSlug = (fields.serviceSlug ?? "").trim() || null;
  const serviceAreaSlug = (fields.serviceAreaSlug ?? "").trim() || null;
  const urgencyRaw = (fields.urgency ?? "").trim();
  if (serviceSlug !== null && !SLUG.test(serviceSlug)) errors.serviceSlug = "Choose a service";
  if (serviceAreaSlug !== null && !SLUG.test(serviceAreaSlug)) errors.serviceAreaSlug = "Choose an area";
  const urgency = urgencyRaw === "" ? null : URGENCY_VALUES.find((value) => value === urgencyRaw);
  if (urgency === undefined) errors.urgency = "Choose an urgency";
  const saleType = fields.saleType === "shared" ? "shared" : fields.saleType === "exclusive" ? "exclusive" : undefined;
  if (!saleType) errors.saleType = "Choose exclusive or shared";
  const pricePence = parsePoundsToPence(fields.price);
  if (pricePence === undefined) errors.price = `Enter a price in pounds, such as 35 or 35.50 (up to £${MAX_PRICE_PENCE / 100})`;
  if (Object.keys(errors).length > 0 || pricePence === undefined || !saleType || urgency === undefined) return { ok: false, errors };
  return { ok: true, value: { serviceSlug, serviceAreaSlug, urgency, saleType, pricePence } };
}

export const formatPence = (pence: number): string => `£${(pence / 100).toFixed(2)}`;
