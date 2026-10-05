import type { Database } from "@/lib/db/client";

/** Small, slow-changing lookup data every submission needs: ids for slugs. */
export interface ReferenceData {
  verticalId: number;
  verticalSlug: string;
  duplicateWindowDays: number;
  serviceTypeIds: ReadonlyMap<string, number>;
  sourceIds: ReadonlyMap<string, number>;
}

export interface ReferenceDataProvider {
  get(verticalSlug: string): Promise<ReferenceData>;
  clear(): void;
}

interface Options {
  /** How long a loaded snapshot is reused. Admin changes take at most this long to apply. */
  ttlMs?: number;
  now?: () => number;
}

export class ReferenceDataMissingError extends Error {
  constructor(what: string) {
    super(`Reference data missing: ${what}. Run "npm run db:seed".`);
    this.name = "ReferenceDataMissingError";
  }
}

export function createReferenceDataProvider(db: Database, options: Options = {}): ReferenceDataProvider {
  const ttlMs = options.ttlMs ?? 60_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { loadedAt: number; data: ReferenceData }>();

  async function load(verticalSlug: string): Promise<ReferenceData> {
    const vertical = await db
      .selectFrom("verticals")
      .select(["id", "slug", "duplicate_window_days"])
      .where("slug", "=", verticalSlug)
      .where("active", "=", true)
      .executeTakeFirst();
    if (!vertical) throw new ReferenceDataMissingError(`active vertical "${verticalSlug}"`);

    const [serviceTypes, sources] = await Promise.all([
      db.selectFrom("service_types").select(["id", "slug"]).where("vertical_id", "=", vertical.id).where("active", "=", true).execute(),
      db.selectFrom("lead_sources").select(["id", "slug"]).where("active", "=", true).execute(),
    ]);
    if (serviceTypes.length === 0) throw new ReferenceDataMissingError(`service types for "${verticalSlug}"`);
    if (sources.length === 0) throw new ReferenceDataMissingError("lead sources");

    return {
      verticalId: vertical.id,
      verticalSlug: vertical.slug,
      duplicateWindowDays: vertical.duplicate_window_days,
      serviceTypeIds: new Map(serviceTypes.map((row) => [row.slug, row.id])),
      sourceIds: new Map(sources.map((row) => [row.slug, row.id])),
    };
  }

  return {
    async get(verticalSlug) {
      const hit = cache.get(verticalSlug);
      if (hit && now() - hit.loadedAt < ttlMs) return hit.data;
      const data = await load(verticalSlug);
      cache.set(verticalSlug, { loadedAt: now(), data });
      return data;
    },
    clear() {
      cache.clear();
    },
  };
}
