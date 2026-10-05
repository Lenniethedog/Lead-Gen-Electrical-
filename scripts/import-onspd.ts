import "./_env";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse";
import { sql } from "kysely";
import { createDb } from "../src/lib/db/client";
import {
  areaOf,
  OnspdFormatError,
  resolveColumns,
  transformRow,
  type OnspdColumns,
  type PostcodeRow,
} from "../src/modules/postcodes/onspd";

/**
 * Loads the ONS Postcode Directory into the `postcodes` table.
 *
 *   npm run postcodes:import -- <path-to-ONSPD_*_UK.csv> [--areas BR,DA,TN] [--edition 2026-08] [--dry-run]
 *
 * Safe to re-run (upserts; never deletes, so historic leads keep a valid postcode). Download the
 * "ONS Postcode Directory" for the latest edition from the ONS Open Geography Portal
 * (geoportal.statistics.gov.uk), unzip it, and point this script at the multi-use CSV in Data/.
 *
 * --areas   only load these postcode areas (leading letters). Default: the whole UK (~1.7M live rows).
 * --edition label stored in postcodes.source ("onspd:2026-08") so you can tell which release a row is from.
 * --dry-run parse and count everything, write nothing.
 */

const BATCH_SIZE = 5_000;
/** If more than this share of the first rows are unusable, the file is wrong: stop before writing anything. */
const MAX_INVALID_SHARE_IN_PREFLIGHT = 0.05;
const PREFLIGHT_ROWS = 20_000;

interface Options {
  file: string;
  areas: Set<string> | null;
  edition: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const args = argv.slice(2);
  let file: string | undefined;
  let areas: string | undefined;
  let edition: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === "--areas") areas = args[(i += 1)];
    else if (arg === "--edition") edition = args[(i += 1)];
    else if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--")) {
      console.error(`Unknown option ${arg}`);
      process.exit(2);
    } else file = arg;
  }

  if (!file) {
    console.error("Usage: npm run postcodes:import -- <ONSPD csv> [--areas BR,DA,TN] [--edition 2026-08] [--dry-run]");
    process.exit(2);
  }
  return {
    file: path.resolve(file),
    areas: areas ? new Set(areas.split(",").map((a) => a.trim().toUpperCase()).filter(Boolean)) : null,
    edition: edition ?? null,
    dryRun,
  };
}

async function main() {
  const options = parseArgs(process.argv);
  await stat(options.file).catch(() => {
    console.error(`File not found: ${options.file}`);
    process.exit(2);
  });

  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url && !options.dryRun) {
    console.error("Neither DATABASE_MIGRATION_URL nor DATABASE_URL is set.");
    process.exit(1);
  }
  const db = url && !options.dryRun ? createDb({ url, ssl: process.env.DATABASE_SSL, poolMax: 2, applicationName: "leadgen-onspd-import" }) : null;
  const source = options.edition ? `onspd:${options.edition}` : "onspd";

  const stats = { read: 0, invalid: 0, filteredOut: 0, upserted: 0, withoutCoordinates: 0, terminated: 0 };
  let columns: OnspdColumns | null = null;
  let batch: PostcodeRow[] = [];

  async function flush() {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    stats.upserted += rows.length;
    if (!db) return;
    await sql`
      insert into postcodes (postcode, lat, lng, admin_district_code, region_code, country_code, introduced_on, terminated_on, source)
      select * from unnest(
        ${rows.map((r) => r.postcode)}::text[], ${rows.map((r) => r.lat)}::float8[], ${rows.map((r) => r.lng)}::float8[],
        ${rows.map((r) => r.districtCode)}::text[], ${rows.map((r) => r.regionCode)}::text[], ${rows.map((r) => r.countryCode)}::text[],
        ${rows.map((r) => r.introducedOn)}::date[], ${rows.map((r) => r.terminatedOn)}::date[], ${rows.map(() => source)}::text[]
      )
      on conflict (postcode) do update set
        lat = excluded.lat, lng = excluded.lng, admin_district_code = excluded.admin_district_code,
        region_code = excluded.region_code, country_code = excluded.country_code,
        introduced_on = excluded.introduced_on, terminated_on = excluded.terminated_on,
        source = excluded.source, loaded_at = now()
    `.execute(db);
  }

  const parser = createReadStream(options.file).pipe(
    parse({ columns: (headers: string[]) => headers.map((h) => h.trim()), bom: true, skip_empty_lines: true, relax_column_count: true }),
  );

  const started = Date.now();
  try {
    for await (const record of parser as AsyncIterable<Record<string, string>>) {
      columns ??= resolveColumns(Object.keys(record));
      stats.read += 1;

      const row = transformRow(record, columns);
      if (row === null) {
        stats.invalid += 1;
      } else if (options.areas && !options.areas.has(areaOf(row.postcode))) {
        stats.filteredOut += 1;
      } else {
        if (row.lat === null) stats.withoutCoordinates += 1;
        if (row.terminatedOn !== null) stats.terminated += 1;
        batch.push(row);
        if (batch.length >= BATCH_SIZE) await flush();
      }

      if (stats.read === PREFLIGHT_ROWS && stats.invalid / stats.read > MAX_INVALID_SHARE_IN_PREFLIGHT) {
        throw new OnspdFormatError(
          `${stats.invalid} of the first ${stats.read} rows are not valid UK postcodes. This is not an ONSPD file, or the 'pcds' column is wrong.`,
        );
      }
      if (stats.read % 250_000 === 0) console.log(`  ...${stats.read.toLocaleString()} rows read`);
    }
    await flush();
  } catch (error) {
    if (error instanceof OnspdFormatError) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    await db?.destroy();
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${options.dryRun ? "DRY RUN (nothing written): " : ""}read ${stats.read.toLocaleString()} rows in ${seconds}s. ` +
      `${options.dryRun ? "would upsert" : "upserted"} ${stats.upserted.toLocaleString()} ` +
      `(${stats.terminated.toLocaleString()} terminated, ${stats.withoutCoordinates.toLocaleString()} without coordinates); ` +
      `skipped ${stats.invalid.toLocaleString()} invalid and ${stats.filteredOut.toLocaleString()} outside --areas.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
