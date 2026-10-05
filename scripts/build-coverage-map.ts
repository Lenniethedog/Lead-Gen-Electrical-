import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import { MAP_VIEW, mapGeometry } from "../src/config/coverage-map";

/**
 * Builds public/images/coverage-map.webp: a muted street map of the launch area, made ONCE from OpenStreetMap tiles and served from our own
 * site, so a visitor's browser never contacts a map provider (no IP address leaves the site) and no script or cookie is involved.
 *
 *   npm run map:build
 *
 * Tiles are cached in .local/map-tiles, so a re-run (for example after restyling) downloads nothing. Only the window in
 * src/config/coverage-map.ts (MAP_VIEW) is fetched: about 40 tiles. OpenStreetMap's tile policy asks for an identifying User-Agent and no bulk
 * downloading; this is a handful of tiles, fetched one at a time. The picture must carry the credit "© OpenStreetMap contributors" (the page does).
 */
const TILE = 256;
const OUT = path.resolve(__dirname, "../public/images/coverage-map.webp");
const CACHE = path.resolve(__dirname, "../.local/map-tiles");
const USER_AGENT = "leadgen-coverage-map-builder/1.0 (one-off static map for a local lead-generation site; https://github.com/Lenniethedog/lead-gen)";

async function tile(z: number, x: number, y: number): Promise<Buffer> {
  const file = path.join(CACHE, `${z}-${x}-${y}.png`);
  try {
    await stat(file);
    return await readFile(file);
  } catch {
    // not cached yet
  }
  const response = await fetch(`https://tile.openstreetmap.org/${z}/${x}/${y}.png`, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await writeFile(file, bytes);
  await new Promise((resolve) => setTimeout(resolve, 300)); // one at a time, politely
  return bytes;
}

async function main(): Promise<void> {
  const { left, top, width, height } = mapGeometry();
  const x0 = Math.floor(left / TILE);
  const y0 = Math.floor(top / TILE);
  const x1 = Math.floor((left + width - 1) / TILE);
  const y1 = Math.floor((top + height - 1) / TILE);
  console.log(`view ${width}x${height}px, tiles x ${x0}..${x1}, y ${y0}..${y1} (${(x1 - x0 + 1) * (y1 - y0 + 1)} tiles)`);

  await mkdir(CACHE, { recursive: true });
  await mkdir(path.dirname(OUT), { recursive: true });

  const layers: OverlayOptions[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) layers.push({ input: await tile(MAP_VIEW.zoom, x, y), left: (x - x0) * TILE, top: (y - y0) * TILE });
  }

  const mosaic = await sharp({ create: { width: (x1 - x0 + 1) * TILE, height: (y1 - y0 + 1) * TILE, channels: 3, background: "#f2efe9" } })
    .composite(layers)
    .png()
    .toBuffer();

  // Crop to exactly the window, then mute it: a pale, warm, low-saturation base keeps roads, parks and the river readable
  // while the coverage circles (the point of the picture) carry the colour.
  await sharp(mosaic)
    .extract({ left: Math.round(left - x0 * TILE), top: Math.round(top - y0 * TILE), width, height })
    .modulate({ saturation: 0.32, brightness: 1.07 })
    .linear(0.82, 36)
    .webp({ quality: 84, effort: 6 })
    .toFile(OUT);

  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
