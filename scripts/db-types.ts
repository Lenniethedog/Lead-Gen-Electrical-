import "./_env";
import { spawnSync } from "node:child_process";

// Regenerates src/lib/db/schema.ts (Kysely types) from the LIVE migrated database, so TypeScript
// types can never drift from the schema. CI runs `npm run db:types -- --verify`.
const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("Neither DATABASE_MIGRATION_URL nor DATABASE_URL is set.");
  process.exit(1);
}

const extra = process.argv.slice(2); // e.g. --verify
const result = spawnSync(
  "npx",
  [
    "kysely-codegen",
    "--dialect", "postgres",
    "--url", url,
    "--out-file", "src/lib/db/schema.ts",
    "--exclude-pattern", "pgmigrations",
    "--log-level", "warn",
    ...extra,
  ],
  { stdio: "inherit", cwd: process.cwd() },
);

process.exit(result.status ?? 1);
