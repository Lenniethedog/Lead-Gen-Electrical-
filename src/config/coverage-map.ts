/**
 * Where each launch area sits, for the map on the landing page (approximate town centres and how far each one reaches; WGS84).
 *
 * Presentation only: which postcodes are actually served is decided by `service_areas` in the database (seeded from
 * db/seeds/service-areas.ts) and the postcode checker is the authority. `coverage-map.test.ts` fails if this list and the seed drift apart.
 * Add a town here when you add it to the seed, then rebuild the picture if the view needs to grow (`npm run map:build`).
 */
export type LabelSide = "t" | "b" | "l" | "r";

export interface CoveragePoint {
  lat: number;
  lng: number;
  /** The name written beside the dot. Defaults to the area's name; an area spread over two towns (Swanley and Sevenoaks) names each dot. */
  label?: string;
  /** Which side of the dot the name sits on (top, bottom, left, right), chosen so no name lands on another name or dot. A test proves it. */
  side: LabelSide;
}

export interface CoverageMapArea {
  slug: string;
  name: string;
  districts: readonly string[];
  /** One dot for most areas; an area that is spread over two towns has two. */
  points: readonly CoveragePoint[];
}

export const COVERAGE_MAP_AREAS: readonly CoverageMapArea[] = [
  { slug: "bromley", name: "Bromley", districts: ["BR1", "BR2", "BR3", "BR4", "BR7"], points: [{ lat: 51.4060, lng: 0.0144, side: "r" }] },
  { slug: "orpington", name: "Orpington", districts: ["BR5", "BR6"], points: [{ lat: 51.3740, lng: 0.0990, side: "r" }] },
  { slug: "bexley", name: "Bexley", districts: ["DA5"], points: [{ lat: 51.4412, lng: 0.1488, side: "r" }] },
  { slug: "bexleyheath", name: "Bexleyheath", districts: ["DA6", "DA7"], points: [{ lat: 51.4600, lng: 0.1420, side: "r" }] },
  { slug: "sidcup", name: "Sidcup", districts: ["DA14", "DA15"], points: [{ lat: 51.4260, lng: 0.1060, side: "l" }] },
  { slug: "welling", name: "Welling", districts: ["DA16"], points: [{ lat: 51.4640, lng: 0.1020, side: "t" }] },
  { slug: "erith", name: "Erith and Belvedere", districts: ["DA8", "DA17", "DA18"], points: [{ lat: 51.4830, lng: 0.1780, side: "r" }] },
  { slug: "eltham", name: "Eltham", districts: ["SE9"], points: [{ lat: 51.4510, lng: 0.0530, side: "t" }] },
  { slug: "catford", name: "Catford and Lee", districts: ["SE6", "SE12"], points: [{ lat: 51.4430, lng: -0.0100, side: "t" }] },
  { slug: "penge", name: "Penge and Sydenham", districts: ["SE20", "SE26"], points: [{ lat: 51.4200, lng: -0.0500, side: "b" }] },
  { slug: "dartford", name: "Dartford", districts: ["DA1", "DA2", "DA3", "DA9", "DA10"], points: [{ lat: 51.4460, lng: 0.2170, side: "b" }] },
  { slug: "gravesend", name: "Gravesend", districts: ["DA11", "DA12", "DA13"], points: [{ lat: 51.4410, lng: 0.3690, side: "b" }] },
  {
    slug: "sevenoaks",
    name: "Sevenoaks and Swanley",
    districts: ["BR8", "DA4", "TN13", "TN14", "TN15"],
    points: [{ lat: 51.3930, lng: 0.1700, label: "Swanley", side: "r" }, { lat: 51.2720, lng: 0.1910, label: "Sevenoaks", side: "r" }],
  },
];

/**
 * The picture's window on the world: Web Mercator at zoom 12 (the same maths as the map tiles it is built from), so a point's place on the
 * picture is exact. Change it and rebuild the picture together (`npm run map:build` reads this).
 */
export const MAP_VIEW = { zoom: 12, north: 51.512, south: 51.222, west: -0.115, east: 0.435 } as const;

const TILE = 256;
const worldX = (lng: number, zoom: number) => ((lng + 180) / 360) * 2 ** zoom * TILE;
const worldY = (lat: number, zoom: number) => {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** zoom * TILE;
};

/** The picture's size in pixels, and where its top-left corner is in world pixels. The map builder and the page both use exactly this. */
export function mapGeometry(view: typeof MAP_VIEW = MAP_VIEW) {
  const left = worldX(view.west, view.zoom);
  const top = worldY(view.north, view.zoom);
  return { left, top, width: Math.round(worldX(view.east, view.zoom) - left), height: Math.round(worldY(view.south, view.zoom) - top) };
}

export interface ProjectedPoint {
  /** Pixels on the picture, and the same as percentages of its width and height (so an overlay scales with the picture). */
  x: number;
  y: number;
  leftPct: number;
  topPct: number;
  label: string;
  side: LabelSide;
}
export interface ProjectedArea { area: CoverageMapArea; points: ProjectedPoint[] }

export function projectAreas(areas: readonly CoverageMapArea[] = COVERAGE_MAP_AREAS, view: typeof MAP_VIEW = MAP_VIEW): { width: number; height: number; areas: ProjectedArea[] } {
  const g = mapGeometry(view);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    width: g.width,
    height: g.height,
    areas: areas.map((area) => ({
      area,
      points: area.points.map((p) => {
        const x = worldX(p.lng, view.zoom) - g.left;
        const y = worldY(p.lat, view.zoom) - g.top;
        return { x: Math.round(x), y: Math.round(y), leftPct: round((x / g.width) * 100), topPct: round((y / g.height) * 100), label: p.label ?? area.name, side: p.side };
      }),
    })),
  };
}
