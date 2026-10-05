import * as z from "zod";

/**
 * Marketing attribution captured on the landing page. This is TELEMETRY: it must never cause a
 * lead to be rejected, so every field is trimmed/truncated/dropped rather than validated strictly.
 */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

function cleaned(max: number) {
  return z
    .string()
    .transform((value) => value.replace(CONTROL_CHARACTERS, "").trim().slice(0, max))
    .transform((value) => (value === "" ? undefined : value))
    .optional()
    .catch(undefined);
}

const pathOnly = z
  .string()
  .transform((value) => value.split(/[?#]/)[0] ?? "")
  .transform((value) => (value.startsWith("/") ? value.slice(0, 300) : undefined))
  .optional()
  .catch(undefined);

const hostOnly = z
  .string()
  .transform((value) => value.trim().toLowerCase().slice(0, 255))
  .transform((value) => (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(value) ? value : undefined))
  .optional()
  .catch(undefined);

export const attributionSchema = z
  .object({
    utmSource: cleaned(200),
    utmMedium: cleaned(200),
    utmCampaign: cleaned(200),
    utmTerm: cleaned(200),
    utmContent: cleaned(200),
    gclid: cleaned(500),
    fbclid: cleaned(500),
    msclkid: cleaned(500),
    landingPath: pathOnly,
    referrerHost: hostOnly,
  })
  .catch({});

export type Attribution = z.output<typeof attributionSchema>;

/** Slugs of the rows in lead_sources (seeded from db/seeds/reference-data.ts). */
export const SOURCE_SLUGS = [
  "google_ads",
  "bing_ads",
  "meta_ads",
  "organic_search",
  "referral",
  "direct",
  "unknown",
] as const;
export type SourceSlug = (typeof SOURCE_SLUGS)[number];

const PAID_MEDIUM = /^(cpc|ppc|paid|paidsearch|paid[_-]?search|paid[_-]?social|paidsocial|cpm|display|ads?)$/i;
const META_SOURCES = new Set(["facebook", "fb", "instagram", "ig", "meta"]);
const BING_SOURCES = new Set(["bing", "microsoft", "msn"]);
const SEARCH_ENGINE_HOST = /(^|\.)(google|bing|duckduckgo|yahoo|ecosia|brave|startpage|qwant)\./i;

/**
 * Which channel brought this visitor? Ordered rules, most reliable evidence first.
 *  - gclid and msclkid are added ONLY by Google/Microsoft Ads auto-tagging, so they prove paid traffic.
 *  - fbclid is appended to EVERY outbound Facebook click (organic posts included), so it proves
 *    nothing on its own: Meta paid traffic is identified by our own UTM tagging of the ad URLs.
 */
export function classifySource(input: Attribution, ownHost?: string): SourceSlug {
  const source = input.utmSource?.toLowerCase();
  const paid = input.utmMedium !== undefined && PAID_MEDIUM.test(input.utmMedium);

  if (input.gclid || (source === "google" && paid)) return "google_ads";
  if (input.msclkid || (source !== undefined && BING_SOURCES.has(source) && paid)) return "bing_ads";
  if (source !== undefined && META_SOURCES.has(source) && paid) return "meta_ads";

  const referrer = input.referrerHost;
  if (referrer && referrer !== ownHost) {
    return SEARCH_ENGINE_HOST.test(referrer) ? "organic_search" : "referral";
  }
  return "direct";
}
