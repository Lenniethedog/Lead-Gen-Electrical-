/**
 * Qualification answers that matter for pricing, routing and client acceptance. Values are stored
 * in Postgres enums of the same names (a test asserts the two never drift apart).
 * Labels are the consumer-facing wording.
 */

export const PROPERTY_TYPE_VALUES = ["house", "bungalow", "flat", "commercial"] as const;
export type PropertyType = (typeof PROPERTY_TYPE_VALUES)[number];
export const PROPERTY_TYPES: Record<PropertyType, { label: string }> = {
  house: { label: "House" },
  bungalow: { label: "Bungalow" },
  flat: { label: "Flat or maisonette" },
  commercial: { label: "Commercial building" },
};

export const OWNERSHIP_VALUES = ["owner", "landlord", "tenant"] as const;
export type Ownership = (typeof OWNERSHIP_VALUES)[number];
export const OWNERSHIPS: Record<Ownership, { label: string; hint?: string }> = {
  owner: { label: "I own the property" },
  landlord: { label: "I'm a landlord or manage it" },
  tenant: { label: "I rent the property", hint: "Check with your landlord before work starts" },
};

export const URGENCY_VALUES = ["emergency", "within_2_weeks", "within_1_month", "just_planning"] as const;
export type Urgency = (typeof URGENCY_VALUES)[number];
export const URGENCIES: Record<Urgency, { label: string; hint?: string }> = {
  emergency: { label: "Urgent", hint: "There's no power, or it feels unsafe right now" },
  within_2_weeks: { label: "Within 2 weeks" },
  within_1_month: { label: "Within a month" },
  just_planning: { label: "Just planning", hint: "Comparing options and prices" },
};
