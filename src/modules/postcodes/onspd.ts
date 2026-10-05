import { normalisePostcode } from "./normalise";

/**
 * Parsing of the ONS Postcode Directory (ONSPD) CSV into rows for our `postcodes` table.
 *
 * ONS publishes ONSPD quarterly under the Open Government Licence. Its column names carry the
 * edition year for geography codes (e.g. `lad25cd`, `rgn25cd`, `ctry25cd`; older editions used
 * `laua`, `rgn`, `ctry`), so columns are RESOLVED BY PATTERN, and the importer refuses to run if a
 * required column is missing rather than guessing.
 *
 * Attribution required by the licence (keep on the privacy/about page of any product using it):
 *   Contains OS data (c) Crown copyright and database right; Contains Royal Mail data (c) Royal Mail
 *   copyright and database right; Source: Office for National Statistics licensed under the Open
 *   Government Licence v3.0. Check the current edition's licence notice when you download it.
 */

export interface OnspdColumns {
  postcode: string;
  lat: string;
  lng: string;
  introduced: string | null;
  terminated: string | null;
  district: string | null;
  region: string | null;
  country: string | null;
}

export class OnspdFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnspdFormatError";
  }
}

const find = (headers: readonly string[], pattern: RegExp): string | null =>
  headers.find((header) => pattern.test(header.trim().toLowerCase())) ?? null;

export function resolveColumns(headers: readonly string[]): OnspdColumns {
  const postcode = find(headers, /^pcds$/);
  const lat = find(headers, /^lat$/);
  const lng = find(headers, /^long$/);
  const missing = [
    postcode === null && "pcds (postcode with space)",
    lat === null && "lat",
    lng === null && "long",
  ].filter(Boolean);
  if (postcode === null || lat === null || lng === null) {
    throw new OnspdFormatError(
      `This does not look like an ONSPD CSV: required column(s) missing: ${missing.join(", ")}. ` +
        `Columns found: ${headers.slice(0, 25).join(", ")}${headers.length > 25 ? ", ..." : ""}`,
    );
  }
  return {
    postcode,
    lat,
    lng,
    introduced: find(headers, /^dointr$/),
    terminated: find(headers, /^doterm$/),
    district: find(headers, /^(laua|lad\d{2}cd)$/),
    region: find(headers, /^(rgn|rgn\d{2}cd)$/),
    country: find(headers, /^(ctry|ctry\d{2}cd)$/),
  };
}

export interface PostcodeRow {
  postcode: string;
  lat: number | null;
  lng: number | null;
  districtCode: string | null;
  regionCode: string | null;
  countryCode: string | null;
  introducedOn: string | null;
  terminatedOn: string | null;
}

/** ONS dates are YYYYMM ("201012"); we store the first of that month. Blank = still live. */
export function parseYearMonth(value: string | undefined): string | null {
  const text = value?.trim() ?? "";
  const match = /^(\d{4})(\d{2})$/.exec(text);
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? `${match[1]}-${match[2]}-01` : null;
}

function parseCoordinate(value: string | undefined, min: number, max: number): number | null {
  const text = value?.trim() ?? "";
  if (text === "") return null;
  const parsed = Number(text);
  // ONSPD marks "no grid reference" with lat 99.999999 / long 0.000000; that is absence, not a place.
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

const optional = (value: string | undefined): string | null => {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
};

/** Returns null for rows that are not usable UK postcodes (the caller counts them). */
export function transformRow(row: Record<string, string>, columns: OnspdColumns): PostcodeRow | null {
  const postcode = normalisePostcode(row[columns.postcode] ?? "");
  if (postcode === null) return null;

  const lat = parseCoordinate(row[columns.lat], 49, 61);
  const lng = parseCoordinate(row[columns.lng], -9, 2.5);
  // The table requires both coordinates or neither.
  const located = lat !== null && lng !== null;

  return {
    postcode,
    lat: located ? lat : null,
    lng: located ? lng : null,
    districtCode: columns.district ? optional(row[columns.district]) : null,
    regionCode: columns.region ? optional(row[columns.region]) : null,
    countryCode: columns.country ? optional(row[columns.country]) : null,
    introducedOn: columns.introduced ? parseYearMonth(row[columns.introduced]) : null,
    terminatedOn: columns.terminated ? parseYearMonth(row[columns.terminated]) : null,
  };
}

/** Postcode area = leading letters of the outward code ("BR6 0AA" -> "BR"). */
export function areaOf(postcode: string): string {
  return /^[A-Z]+/.exec(postcode)?.[0] ?? "";
}
