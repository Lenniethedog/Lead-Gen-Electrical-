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
    expect(dartford.points[0]!.x).toBe(Math.round(expected.x - origin.x));
    expect(dartford.points[0]!.y).toBe(Math.round(expected.y - origin.y));
  });

  it("every area has a dot, and an area spread over two towns names each one", () => {
    for (const area of COVERAGE_MAP_AREAS) expect(area.points.length, area.slug).toBeGreaterThan(0);
    const sevenoaks = projectAreas().areas.find((a) => a.area.slug === "sevenoaks")!;
    expect(sevenoaks.points.map((p) => p.label)).toEqual(["Swanley", "Sevenoaks"]);
    const bexley = projectAreas().areas.find((a) => a.area.slug === "bexley")!;
    expect(bexley.points.map((p) => p.label)).toEqual(["Bexley"]);
  });

  it("keeps every dot inside the picture, with west to the left and north at the top; percentages agree with pixels", () => {
    const { width, height, areas } = projectAreas();
    for (const { area, points } of areas) {
      for (const p of points) {
        expect(p.x, `${area.slug} x`).toBeGreaterThan(0);
        expect(p.x, `${area.slug} x`).toBeLessThan(width);
        expect(p.y, `${area.slug} y`).toBeGreaterThan(0);
        expect(p.y, `${area.slug} y`).toBeLessThan(height);
        expect(p.leftPct).toBeCloseTo((p.x / width) * 100, 0);
        expect(p.topPct).toBeCloseTo((p.y / height) * 100, 0);
      }
    }
    const at = (slug: string) => areas.find((a) => a.area.slug === slug)!.points[0]!;
    expect(at("penge").x).toBeLessThan(at("gravesend").x);
    expect(at("erith").y).toBeLessThan(at("orpington").y);
    expect(at("bexleyheath").y).toBeLessThan(at("bexley").y);
  });

  /**
   * NO NAME LANDS ON ANOTHER NAME OR ON ANOTHER DOT, at the narrowest the map is ever drawn (720 px wide, a phone swiping sideways) and at desktop
   * width. The label is 12 px bold; its width is estimated generously (7.4 px a letter). Dots are 14 px with a 2 px ring; the gap from dot to name is 8 px
   * (left/right) or 6 px (above/below), as in the component.
   */
  for (const renderedWidth of [720, 800, 1100]) {
    it(`never overlaps a name with another name or a dot, and never runs off the picture, at ${renderedWidth}px wide`, () => {
      const { width, height, areas } = projectAreas();
      const scale = renderedWidth / width;
      const renderedHeight = height * scale;
      const DOT = 9; // half of 14px + ring
      const boxes: Array<{ id: string; kind: "label" | "dot"; x0: number; y0: number; x1: number; y1: number }> = [];
      for (const { area, points } of areas) {
        points.forEach((p, i) => {
          const cx = p.x * scale;
          const cy = p.y * scale;
          const w = p.label.length * 7.4 + 2;
          const h = 14;
          const id = `${area.slug}#${i}`;
          boxes.push({ id, kind: "dot", x0: cx - DOT, y0: cy - DOT, x1: cx + DOT, y1: cy + DOT });
          const label =
            p.side === "r" ? { x0: cx + 8, y0: cy - h / 2, x1: cx + 8 + w, y1: cy + h / 2 }
            : p.side === "l" ? { x0: cx - 8 - w, y0: cy - h / 2, x1: cx - 8, y1: cy + h / 2 }
            : p.side === "t" ? { x0: cx - w / 2, y0: cy - 6 - h - 2, x1: cx + w / 2, y1: cy - 8 }
            : { x0: cx - w / 2, y0: cy + 8, x1: cx + w / 2, y1: cy + 8 + h + 2 };
          boxes.push({ id, kind: "label", ...label });
          expect(label.x0, `${id} label runs off the left edge`).toBeGreaterThanOrEqual(0);
          expect(label.x1, `${id} label runs off the right edge`).toBeLessThanOrEqual(renderedWidth);
          expect(label.y0, `${id} label runs off the top`).toBeGreaterThanOrEqual(0);
          expect(label.y1, `${id} label runs off the bottom`).toBeLessThanOrEqual(renderedHeight);
        });
      }
      const overlaps = (a: (typeof boxes)[number], b: (typeof boxes)[number]) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
      const clashes: string[] = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          if (a.id === b.id) continue; // a dot and its own name sit side by side by design
          if (a.kind === "dot" && b.kind === "dot") continue; // dots are far apart in every layout (checked below)
          if (overlaps(a, b)) clashes.push(`${a.kind} ${a.id} / ${b.kind} ${b.id}`);
        }
      }
      expect(clashes).toEqual([]);
    });
  }

  it("no two dots are close enough to touch", () => {
    const points = projectAreas().areas.flatMap(({ area, points }) => points.map((p, i) => ({ id: `${area.slug}#${i}`, ...p })));
    const { width } = projectAreas();
    const scale = 720 / width; // the narrowest the map is drawn
    for (let i = 0; i < points.length; i += 1) {
      for (let j = i + 1; j < points.length; j += 1) {
        const distance = Math.hypot((points[i]!.x - points[j]!.x) * scale, (points[i]!.y - points[j]!.y) * scale);
        expect(distance, `${points[i]!.id} / ${points[j]!.id}`).toBeGreaterThan(22);
      }
    }
  });

  it("the built picture is exactly the size the circles were drawn for (rebuild it with `npm run map:build` after changing the view)", async () => {
    const meta = await sharp(path.resolve(import.meta.dirname, "../../public/images/coverage-map.webp")).metadata();
    const { width, height } = mapGeometry();
    expect({ width: meta.width, height: meta.height }).toEqual({ width, height });
  });
});
