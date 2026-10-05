import "./_env";
import { createDb } from "../src/lib/db/client";
import { getBrand } from "../src/config/brand";
import { seedReferenceData } from "../db/seeds/reference-data";

// Loads reference data (vertical, services, lead sources, launch footprint, consent wording).
//   npm run db:seed                       idempotent; safe on every deploy
//   npm run db:seed -- --dev-postcodes    ALSO loads synthetic postcodes (never in staging/production)
async function main() {
  const includeDevPostcodes = process.argv.includes("--dev-postcodes");
  const appEnv = process.env.APP_ENV ?? "development";
  if (includeDevPostcodes && (appEnv === "production" || appEnv === "staging")) {
    console.error(`Refusing to load synthetic postcodes with APP_ENV=${appEnv}. Use npm run postcodes:import.`);
    process.exit(1);
  }

  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("Neither DATABASE_MIGRATION_URL nor DATABASE_URL is set.");
    process.exit(1);
  }

  const db = createDb({ url, ssl: process.env.DATABASE_SSL, poolMax: 2, applicationName: "leadgen-seed" });
  try {
    const summary = await seedReferenceData(db, { brandName: getBrand().name, includeDevPostcodes });
    console.log("Seeded:", JSON.stringify(summary));
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
