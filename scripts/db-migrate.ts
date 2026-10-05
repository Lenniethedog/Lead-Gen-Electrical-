import "./_env";
import path from "node:path";
import { runner } from "node-pg-migrate";
import { pgConnectionConfig } from "../src/lib/db/config";

// Roll-forward only: applies pending SQL migrations in db/migrations, in order, in ONE transaction
// (all or nothing), under an advisory lock so two deploys can never migrate concurrently.
async function main() {
  const command = process.argv[2] ?? "up";
  if (command !== "up") {
    console.error(`Unsupported command "${command}". Migrations are roll-forward only: use "up".`);
    process.exit(2);
  }

  const url = process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error("Neither DATABASE_MIGRATION_URL nor DATABASE_URL is set.");
    process.exit(1);
  }

  const applied = await runner({
    databaseUrl: pgConnectionConfig({ url, ssl: process.env.DATABASE_SSL }),
    dir: path.resolve(process.cwd(), "db/migrations"),
    direction: "up",
    migrationsTable: "pgmigrations",
    checkOrder: true,
    singleTransaction: true,
    advisoryLockMode: "wait",
    log: (message) => console.log(message),
  });

  console.log(applied.length === 0 ? "Database is up to date." : `Applied ${applied.length} migration(s).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
