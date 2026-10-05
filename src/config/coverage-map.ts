/**
 * Where each launch area sits, for the schematic map on the landing page (approximate town centres, WGS84).
 *
 * This is presentation only: which postcodes are actually served is decided by `service_areas` in the database
 * (seeded from db/seeds/service-areas.ts). `coverage-map.test.ts` fails if this list and the seed drift apart.
 * Add a town here when you add it to the seed.
 */
export interface CoverageMapArea {
  slug: string;
  name: string;
  districts: readonly string[];
  lat: number;
  lng: number;
}

export const COVERAGE_MAP_AREAS: readonly CoverageMapArea[] = [
  { slug: "bromley", name: "Bromley", districts: ["BR1", "BR2", "BR3", "BR4", "BR7"], lat: 51.4060, lng: 0.0144 },
  { slug: "orpington", name: "Orpington", districts: ["BR5", "BR6"], lat: 51.3740, lng: 0.0990 },
  { slug: "sevenoaks", name: "Sevenoaks and Swanley", districts: ["BR8", "DA4", "TN13", "TN14", "TN15"], lat: 51.3010, lng: 0.1900 },
  { slug: "dartford", name: "Dartford", districts: ["DA1", "DA2", "DA3", "DA9", "DA10"], lat: 51.4460, lng: 0.2170 },
  { slug: "gravesend", name: "Gravesend", districts: ["DA11", "DA12", "DA13"], lat: 51.4410, lng: 0.3690 },
];

const VIEW_WIDTH = 640;
const PAD = 90;

/** Equirectangular projection, corrected for latitude so distances look right at this latitude. */
export function projectAreas(areas: readonly CoverageMapArea[]): { width: number; height: number; points: { area: CoverageMapArea; x: number; y: number }[] } {
  const lats = areas.map((a) => a.lat);
  const lngs = areas.map((a) => a.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = (Math.max(...lngs) - Math.min(...lngs)) * kx || 1;
  const spanY = Math.max(...lats) - Math.min(...lats) || 1;
  const scale = (VIEW_WIDTH - 2 * PAD) / spanX;
  const height = Math.round(spanY * scale + 2 * PAD);
  const points = areas.map((area) => ({
    area,
    x: Math.round((area.lng - Math.min(...lngs)) * kx * scale + PAD),
    y: Math.round((Math.max(...lats) - area.lat) * scale + PAD),
  }));
  return { width: VIEW_WIDTH, height, points };
}
