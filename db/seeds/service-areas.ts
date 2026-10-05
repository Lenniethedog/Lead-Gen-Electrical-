/**
 * Launch footprint: the postcode districts (outward codes) we accept enquiries from.
 *
 * STARTING ASSUMPTION - edit before launch. A district belongs here only when you have (or are
 * about to have) a paying business that covers it: every enquiry from an area nobody serves is
 * wasted ad spend. Seeding is additive (it never removes districts); to shrink the footprint,
 * deactivate the area (service_areas.active = false) or write a migration.
 *
 * Must stay in sync with BRAND_LAUNCH_REGION, the human-readable label on the landing page.
 */
export const SERVICE_AREAS = [
  { slug: "orpington", name: "Orpington", districts: ["BR5", "BR6"] },
  { slug: "bromley", name: "Bromley", districts: ["BR1", "BR2", "BR3", "BR4", "BR7"] },
  { slug: "sevenoaks", name: "Sevenoaks and Swanley", districts: ["BR8", "DA4", "TN13", "TN14", "TN15"] },
  { slug: "dartford", name: "Dartford", districts: ["DA1", "DA2", "DA3", "DA9", "DA10"] },
  { slug: "gravesend", name: "Gravesend", districts: ["DA11", "DA12", "DA13"] },
] as const;
