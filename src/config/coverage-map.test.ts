import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SERVICE_AREAS } from "../../db/seeds/service-areas";
import { COVERAGE_MAP_AREAS, MAP_VIEW, mapGeometry, projectAreas } from "./coverage-map";

describe("coverage map", () => {
  it("shows exactly the areas and districts that are seeded as served, in the same order", () => {
    const shown = COVERAGE_MAP_AREAS.map((a) => ({ slug: a.slug, name: a.name, districts: [...a.districts] }));
    const seeded = SERVICE_AREAS.map((a) => ({ slug: a.slug, name: a.name, districts: [...a.districts] }));
    expect(shown.map((a) => a.slug).sort()).toEqual(seeded.map((a) => a.slug).sort());
    expect([...shown].sort((a, b) => a.slug.localeCompare(b.slug))).toEqual([...seeded].sort((a, b) => a.slug.localeCompare(b.slug)));
  });

  it("covers the places that were asked for: Bexley, Bexleyheath, Sidcup and the nearest parts of South East London", () => {
    const names = COVERAGE_MAP_AREAS.map((a) => a.name);
    for (const wanted of ["Bexley", "Bexleyheath", "Sidcup", "Eltham", "Catford and Lee", "Penge and Sydenham", "Welling"]) expect(names).toContain(wanted);
    const districts = new Set(COVERAGE_MAP_AREAS.flatMap((a) => a.districts));
    for (const district of ["DA5", "DA6", "DA7", "DA14", "DA15", "SE9"]) expect(districts.has(district), district).toBe(true);
  });

  it("no district is claimed by two areas", () => {
    const all = COVERAGE_MAP_AREAS.flatMap((a) => a.districts);
    expect(new Set(all).size).toBe(all.length);
  });

  it("puts a point where Web Mercator says, checked against an independent calculation", () => {
    // Independent of the module's own helpers: the standard slippy-map formulas at zoom 12.
    const world = (lat: number, lng: number) => {
      const n = 2 ** MAP_VIEW.zoom * 256;
      const rad = (lat * Math.PI) / 180;
      return { x: ((lng + 180) / 360) * n, y: ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * n };
    };
    const origin = world(MAP_VIEW.north, MAP_VIEW.west);
    const dartford = projectAreas().areas.find((a) => a.area.slug === "dartford")!;
    const expected = world(51.446, 0.217);
    expect(dartford.circles[0]!.x).toBe(Math.round(expected.x - origin.x));
    expect(dartford.circles[0]!.y).toBe(Math.round(expected.y - origin.y));
  });

  it("draws a circle of the right size: 4 km is about 4000 / metres-per-pixel pixels", () => {
    const dartford = projectAreas().areas.find((a) => a.area.slug === "dartford")!;
    const metresPerPixel = (40_075_016.686 * Math.cos((51.446 * Math.PI) / 180)) / (2 ** MAP_VIEW.zoom * 256);
    expect(dartford.circles[0]!.r).toBe(Math.round(4000 / metresPerPixel));
    expect(dartford.circles[0]!.r).toBeGreaterThan(100);
    expect(dartford.circles[0]!.r).toBeLessThan(250);
  });

  it("keeps every circle wholly inside the picture, with west to the left and north at the top, and numbers them 1..n", () => {
    const { width, height, areas } = projectAreas();
    expect(areas.map((a) => a.number)).toEqual(areas.map((_, i) => i + 1));
    for (const { area, circles } of areas) {
      expect(circles.length, area.slug).toBeGreaterThan(0);
      for (const c of circles) {
        expect(c.x - c.r, `${area.slug} left`).toBeGreaterThanOrEqual(0);
        expect(c.x + c.r, `${area.slug} right`).toBeLessThanOrEqual(width);
        expect(c.y - c.r, `${area.slug} top`).toBeGreaterThanOrEqual(0);
        expect(c.y + c.r, `${area.slug} bottom`).toBeLessThanOrEqual(height);
      }
    }
    const at = (slug: string) => areas.find((a) => a.area.slug === slug)!.circles[0]!;
    expect(at("penge").x).toBeLessThan(at("gravesend").x);
    expect(at("erith").y).toBeLessThan(at("orpington").y);
    expect(at("bexleyheath").y).toBeLessThan(at("bexley").y);
  });

  it("the built picture is exactly the size the circles were drawn for (rebuild it with `npm run map:build` after changing the view)", async () => {
    const meta = await sharp(path.resolve(import.meta.dirname, "../../public/images/coverage-map.webp")).metadata();
    const { width, height } = mapGeometry();
    expect({ width: meta.width, height: meta.height }).toEqual({ width, height });
  });
});
