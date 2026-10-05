import type { Database } from "@/lib/db/client";
import { normalisePostcode, outwardOf } from "./normalise";
import { findFootprintArea, findPostcode } from "./repo";

export type PostcodeCheck =
  | { status: "covered"; postcode: string; outward: string; areaName: string; lat: number | null; lng: number | null }
  | { status: "out_of_area"; outward: string }
  | { status: "not_found"; outward: string }
  | { status: "invalid_format" };

export interface PostcodeService {
  check(input: string, verticalId: number): Promise<PostcodeCheck>;
}

/**
 * Answers "can we serve this postcode?" with real data:
 *   1. is it structurally a UK postcode?
 *   2. is its outward code inside the vertical's footprint? (decided first: an out-of-area visitor
 *      is told so even if their postcode is mistyped - the more useful answer)
 *   3. does it exist in the ONS Postcode Directory?
 */
export function createPostcodeService(db: Database): PostcodeService {
  return {
    async check(input, verticalId) {
      const postcode = normalisePostcode(input);
      if (postcode === null) return { status: "invalid_format" };

      const outward = outwardOf(postcode);
      const [areaName, record] = await Promise.all([
        findFootprintArea(db, verticalId, outward),
        findPostcode(db, postcode),
      ]);

      if (areaName === undefined) return { status: "out_of_area", outward };
      if (record === undefined) return { status: "not_found", outward };
      return { status: "covered", postcode, outward, areaName, lat: record.lat, lng: record.lng };
    },
  };
}
