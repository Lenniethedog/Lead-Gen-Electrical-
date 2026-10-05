/**
 * Where each launch area sits, for the map on the landing page (approximate town centres and how far each one reaches; WGS84).
 *
 * Presentation only: which postcodes are actually served is decided by `service_areas` in the database (seeded from
 * db/seeds/service-areas.ts) and the postcode checker is the authority. `coverage-map.test.ts` fails if this list and the seed drift apart.
 * Add a town here when you add it to the seed, then rebuild the picture if the view needs to grow (`npm run map:build`).
 */
export interface CoverageCircle {
  lat: number;
  lng: number;
  /** How far the area reaches from that point, in kilometres: a guide for the eye, not a boundary. */
  radiusKm: number;
}

export interface CoverageMapArea {
  slug: string;
  name: string;
  districts: readonly string[];
  /** One circle for most areas; an area that is long and thin (Swanley to Sevenoaks) uses two. */
  circles: readonly CoverageCircle[];
  /** Where on the circle's edge its number sits, in degrees clockwise from east (270 = top). Keeps the number off the town's name and out of its neighbours. */
  badgeAngle?: number;
}

export const COVERAGE_MAP_AREAS: readonly CoverageMapArea[] = [
  { slug: "bromley", name: "Bromley", districts: ["BR1", "BR2", "BR3", "BR4", "BR7"], circles: [{ lat: 51.4060, lng: 0.0144, radiusKm: 3.4 }], badgeAngle: 135 },
  { slug: "orpington", name: "Orpington", districts: ["BR5", "BR6"], circles: [{ lat: 51.3740, lng: 0.0990, radiusKm: 3.6 }], badgeAngle: 90 },
  { slug: "bexley", name: "Bexley", districts: ["DA5"], circles: [{ lat: 51.4412, lng: 0.1488, radiusKm: 1.6 }], badgeAngle: 20 },
  { slug: "bexleyheath", name: "Bexleyheath", districts: ["DA6", "DA7"], circles: [{ lat: 51.4600, lng: 0.1420, radiusKm: 1.9 }], badgeAngle: 300 },
  { slug: "sidcup", name: "Sidcup", districts: ["DA14", "DA15"], circles: [{ lat: 51.4260, lng: 0.1060, radiusKm: 2.3 }], badgeAngle: 200 },
  { slug: "welling", name: "Welling", districts: ["DA16"], circles: [{ lat: 51.4640, lng: 0.1020, radiusKm: 1.6 }], badgeAngle: 270 },
  { slug: "erith", name: "Erith and Belvedere", districts: ["DA8", "DA17", "DA18"], circles: [{ lat: 51.4830, lng: 0.1780, radiusKm: 2.6 }], badgeAngle: 270 },
  { slug: "eltham", name: "Eltham", districts: ["SE9"], circles: [{ lat: 51.4510, lng: 0.0530, radiusKm: 2.2 }], badgeAngle: 270 },
  { slug: "catford", name: "Catford and Lee", districts: ["SE6", "SE12"], circles: [{ lat: 51.4430, lng: -0.0100, radiusKm: 2.8 }], badgeAngle: 270 },
  { slug: "penge", name: "Penge and Sydenham", districts: ["SE20", "SE26"], circles: [{ lat: 51.4200, lng: -0.0500, radiusKm: 3.0 }], badgeAngle: 200 },
  { slug: "dartford", name: "Dartford", districts: ["DA1", "DA2", "DA3", "DA9", "DA10"], circles: [{ lat: 51.4460, lng: 0.2170, radiusKm: 4.0 }], badgeAngle: 40 },
  { slug: "gravesend", name: "Gravesend", districts: ["DA11", "DA12", "DA13"], circles: [{ lat: 51.4410, lng: 0.3690, radiusKm: 4.0 }], badgeAngle: 270 },
  { slug: "sevenoaks", name: "Sevenoaks and Swanley", districts: ["BR8", "DA4", "TN13", "TN14", "TN15"], circles: [{ lat: 51.3930, lng: 0.1700, radiusKm: 2.8 }, { lat: 51.2720, lng: 0.1910, radiusKm: 4.4 }], badgeAngle: 90 },
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
const metresPerPixel = (lat: number, zoom: number) => (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (2 ** zoom * TILE);

/** The picture's size in pixels, and where its top-left corner is in world pixels. The map builder and the page both use exactly this. */
export function mapGeometry(view: typeof MAP_VIEW = MAP_VIEW) {
  const left = worldX(view.west, view.zoom);
  const top = worldY(view.north, view.zoom);
  return { left, top, width: Math.round(worldX(view.east, view.zoom) - left), height: Math.round(worldY(view.south, view.zoom) - top) };
}

export interface ProjectedCircle { x: number; y: number; r: number }
export interface ProjectedArea { area: CoverageMapArea; number: number; circles: ProjectedCircle[]; /** One number per circle, on its edge. */ badges: Array<{ x: number; y: number }> }

export function projectAreas(areas: readonly CoverageMapArea[] = COVERAGE_MAP_AREAS, view: typeof MAP_VIEW = MAP_VIEW): { width: number; height: number; areas: ProjectedArea[] } {
  const g = mapGeometry(view);
  return {
    width: g.width,
    height: g.height,
    areas: areas.map((area, index) => {
      const circles = area.circles.map((c) => ({
        x: Math.round(worldX(c.lng, view.zoom) - g.left),
        y: Math.round(worldY(c.lat, view.zoom) - g.top),
        r: Math.round((c.radiusKm * 1000) / metresPerPixel(c.lat, view.zoom)),
      }));
      const angle = ((area.badgeAngle ?? 270) * Math.PI) / 180;
      return { area, number: index + 1, circles, badges: circles.map((c) => ({ x: Math.round(c.x + c.r * Math.cos(angle)), y: Math.round(c.y + c.r * Math.sin(angle)) })) };
    }),
  };
}
