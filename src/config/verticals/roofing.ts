/**
 * The roofing vertical: what the consumer can ask for, and the follow-up "scope" question that
 * best predicts job size for each service. This file is the single source of truth for the form,
 * for server-side validation and (via db/seeds) for the service_types table.
 *
 * Changing the niche means replacing this file, the seeds and the copy in the landing components;
 * nothing else in the platform is roofing-specific.
 */

export const SERVICE_SLUGS = [
  "roof_repair",
  "new_roof",
  "flat_roof",
  "chimney",
  "guttering_fascias",
  "roof_inspection",
  "other",
] as const;
export type ServiceSlug = (typeof SERVICE_SLUGS)[number];

export interface ScopeOption {
  value: string;
  label: string;
}

export interface ServiceDefinition {
  label: string;
  hint: string;
  /** Question 4: "which best describes the work?" Values are stored in leads.details.scope. */
  scopes: readonly [ScopeOption, ...ScopeOption[]];
}

export const SERVICES: Record<ServiceSlug, ServiceDefinition> = {
  roof_repair: {
    label: "Roof repair or leak",
    hint: "Leaks, slipped or missing tiles, storm damage",
    scopes: [
      { value: "leak", label: "The roof is leaking" },
      { value: "tiles", label: "Slipped, cracked or missing tiles" },
      { value: "storm_damage", label: "Storm or wind damage" },
      { value: "other_repair", label: "Something else" },
    ],
  },
  new_roof: {
    label: "New roof or re-roof",
    hint: "Replace all or part of your roof",
    scopes: [
      { value: "full_replacement", label: "Replace the whole roof" },
      { value: "partial_replacement", label: "Replace part of the roof" },
      { value: "extension_or_build", label: "New extension or new build" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  flat_roof: {
    label: "Flat roof",
    hint: "Repair, replacement or a new flat roof",
    scopes: [
      { value: "leak", label: "The flat roof is leaking" },
      { value: "replace", label: "Replace the flat roof" },
      { value: "new_flat_roof", label: "New flat roof (extension, garage, dormer)" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  chimney: {
    label: "Chimney work",
    hint: "Repairs, repointing, flashing or removal",
    scopes: [
      { value: "repair_repoint", label: "Repair or repointing" },
      { value: "leadwork", label: "Flashing or leadwork" },
      { value: "removal_rebuild", label: "Removal or rebuild" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  guttering_fascias: {
    label: "Gutters, fascias & soffits",
    hint: "Replace, repair or clear",
    scopes: [
      { value: "replace", label: "Replace gutters, fascias or soffits" },
      { value: "repair", label: "Repair or realign gutters" },
      { value: "clean", label: "Clear or clean gutters" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  roof_inspection: {
    label: "Roof inspection or survey",
    hint: "A professional opinion on the condition of your roof",
    scopes: [
      { value: "condition_survey", label: "Check the condition of my roof" },
      { value: "sale_or_purchase", label: "For a house sale or purchase" },
      { value: "insurance_report", label: "Insurance or damage report" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  other: {
    label: "Something else",
    hint: "Tell us what you need",
    scopes: [
      { value: "need_advice", label: "I need advice on what to do" },
      { value: "other_work", label: "Other roofing work" },
    ],
  },
};

export function isServiceSlug(value: string): value is ServiceSlug {
  return (SERVICE_SLUGS as readonly string[]).includes(value);
}

export function isValidScope(service: ServiceSlug, scope: string): boolean {
  return SERVICES[service].scopes.some((option) => option.value === scope);
}

export const ROOFING = {
  slug: "roofing",
  name: "Roofing",
  /** Same job re-submitted inside this window is a duplicate (stored in verticals.duplicate_window_days). */
  duplicateWindowDays: 14,
} as const;
