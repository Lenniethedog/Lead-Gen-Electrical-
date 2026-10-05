import { describe, expect, it } from "vitest";
import { SERVICE_AREAS } from "../../db/seeds/service-areas";
import { COVERAGE_MAP_AREAS, projectAreas } from "./coverage-map";

describe("coverage map", () => {
  it("shows exactly the areas and districts that are seeded as served", () => {
    const shown = [...COVERAGE_MAP_AREAS].map((a) => ({ slug: a.slug, name: a.name, districts: [...a.districts] })).sort((a, b) => a.slug.localeCompare(b.slug));
    const seeded = SERVICE_AREAS.map((a) => ({ slug: a.slug, name: a.name, districts: [...a.districts] })).sort((a, b) => a.slug.localeCompare(b.slug));
    expect(shown).toEqual(seeded);
  });

  it("places every area inside the drawing, with west to the left and north at the top", () => {
    const { width, height, points } = projectAreas(COVERAGE_MAP_AREAS);
    for (const p of points) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(width);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(height);
    }
    const at = (slug: string) => points.find((p) => p.area.slug === slug)!;
    expect(at("bromley").x).toBeLessThan(at("gravesend").x);
    expect(at("dartford").y).toBeLessThan(at("sevenoaks").y);
  });
});
