import type { Database } from "@/lib/db/client";

export interface PostcodeRecord {
  postcode: string;
  outward: string;
  lat: number | null;
  lng: number | null;
}

/**
 * A postcode that exists today. Terminated postcodes stay in the table (an old lead's postcode must keep resolving) but are not
 * accepted for a new enquiry: no property has one, so it is a typo or a made-up value, and "we couldn't find that postcode" is the right answer.
 */
export async function findPostcode(db: Database, postcode: string): Promise<PostcodeRecord | undefined> {
  return db
    .selectFrom("postcodes")
    .select(["postcode", "outward", "lat", "lng"])
    .where("postcode", "=", postcode)
    .where("terminated_on", "is", null)
    .executeTakeFirst();
}

/** Name of the active service area (for this vertical) that includes the outward code, if any. */
export async function findFootprintArea(
  db: Database,
  verticalId: number,
  outward: string,
): Promise<string | undefined> {
  const row = await db
    .selectFrom("vertical_service_areas as vsa")
    .innerJoin("service_areas as sa", "sa.id", "vsa.service_area_id")
    .innerJoin("service_area_districts as d", "d.service_area_id", "sa.id")
    .select("sa.name")
    .where("vsa.vertical_id", "=", verticalId)
    .where("vsa.active", "=", true)
    .where("sa.active", "=", true)
    .where("d.outward", "=", outward)
    .orderBy("sa.name")
    .limit(1)
    .executeTakeFirst();
  return row?.name;
}
