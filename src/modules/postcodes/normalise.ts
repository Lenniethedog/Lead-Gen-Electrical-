/**
 * UK postcode handling shared by the browser and the server (pure, no dependencies).
 *
 * Structure: <outward><space><inward>. The inward code is always the last three characters
 * (digit + two letters); the outward code (area + district) is everything before it.
 * Format validity is checked here; whether the postcode actually EXISTS is the database's job
 * (ONS Postcode Directory), and whether we serve it is the service-area footprint's job.
 */

const OUTWARD_PATTERN = /^[A-Z]{1,2}[0-9][A-Z0-9]?$/;
const INWARD_PATTERN = /^[0-9][A-Z]{2}$/;

/** Canonical form ("BR6 0AA") or null if the input cannot be a UK postcode. Generous about spacing. */
export function normalisePostcode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact.length < 5 || compact.length > 7) return null;
  const outward = compact.slice(0, -3);
  const inward = compact.slice(-3);
  if (!OUTWARD_PATTERN.test(outward) || !INWARD_PATTERN.test(inward)) return null;
  return `${outward} ${inward}`;
}

/** Outward code of an already-normalised postcode ("BR6 0AA" -> "BR6"). */
export function outwardOf(postcode: string): string {
  return postcode.split(" ")[0] ?? postcode;
}
