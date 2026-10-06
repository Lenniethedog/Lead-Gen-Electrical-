/**
 * The electrical vertical: what the consumer can ask for, and the follow-up "scope" question that
 * best predicts job size for each service. This file is the single source of truth for the form,
 * for server-side validation and (via db/seeds) for the service_types table.
 *
 * Changing the niche means replacing this file, the seeds and the copy in the landing components;
 * nothing else in the platform is trade-specific.
 *
 * Why these services (docs/00 E2): they are the jobs people search for by name, they differ a lot in
 * value (a rewire or a consumer unit is worth far more than a socket), and a business that does one
 * often does not do another (EV chargers, inspection and testing), so each is routed on its own.
 */

export const SERVICE_SLUGS = [
  "fault_repair",
  "consumer_unit",
  "rewire",
  "eicr",
  "ev_charger",
  "lighting_sockets",
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
  fault_repair: {
    label: "Electrical fault or repair",
    hint: "No power, tripping switches, sockets or lights not working",
    scopes: [
      { value: "no_power", label: "Part or all of the property has no power" },
      { value: "tripping", label: "The fuse board keeps tripping" },
      { value: "socket_or_light", label: "A socket, switch or light isn't working" },
      { value: "other_fault", label: "Something else" },
    ],
  },
  consumer_unit: {
    label: "Fuse box / consumer unit",
    hint: "Replace an old fuse box with a modern consumer unit",
    scopes: [
      { value: "replace_fuse_box", label: "Replace an old fuse box" },
      { value: "upgrade_consumer_unit", label: "Upgrade a consumer unit (e.g. add RCD protection)" },
      { value: "extra_circuits", label: "Add circuits to my consumer unit" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  rewire: {
    label: "Rewire",
    hint: "Replace the wiring in all or part of a property",
    scopes: [
      { value: "full_rewire", label: "Full rewire" },
      { value: "partial_rewire", label: "Part of the property" },
      { value: "renovation_or_extension", label: "Renovation, extension or new build" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  eicr: {
    label: "Electrical safety check (EICR)",
    hint: "An inspection and report on the condition of your wiring",
    scopes: [
      { value: "landlord_certificate", label: "For a rented property (landlord)" },
      { value: "sale_or_purchase", label: "For a house sale or purchase" },
      { value: "periodic_check", label: "A routine check of my own home" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  ev_charger: {
    label: "EV charger installation",
    hint: "A home charge point for an electric car",
    scopes: [
      { value: "home_charger", label: "A charger at my house" },
      { value: "flat_or_shared", label: "A charger at a flat or shared parking" },
      { value: "business_chargers", label: "Chargers for a business or workplace" },
      { value: "unsure", label: "Not sure yet" },
    ],
  },
  lighting_sockets: {
    label: "Lighting, sockets & new circuits",
    hint: "Extra sockets, new lights, an outside supply or a new circuit",
    scopes: [
      { value: "extra_sockets", label: "More sockets or switches" },
      { value: "lighting", label: "New or replacement lighting" },
      { value: "new_circuit", label: "A new circuit (cooker, shower, outbuilding)" },
      { value: "outdoor_power", label: "Outdoor lighting or power" },
    ],
  },
  other: {
    label: "Something else",
    hint: "Tell us what you need",
    scopes: [
      { value: "need_advice", label: "I need advice on what to do" },
      { value: "other_work", label: "Other electrical work" },
    ],
  },
};

export function isServiceSlug(value: string): value is ServiceSlug {
  return (SERVICE_SLUGS as readonly string[]).includes(value);
}

export function isValidScope(service: ServiceSlug, scope: string): boolean {
  return SERVICES[service].scopes.some((option) => option.value === scope);
}

export const ELECTRICAL = {
  slug: "electrical",
  name: "Electrical",
  /** Same job re-submitted inside this window is a duplicate (stored in verticals.duplicate_window_days). */
  duplicateWindowDays: 14,
} as const;
