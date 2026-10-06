import path from "node:path";
import { fileURLToPath } from "node:url";
import { runner } from "node-pg-migrate";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { createDb } from "../../src/lib/db/client";
import { seedReferenceData } from "../../db/seeds/reference-data";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const APP_ROLE = "leadgen_app";
export const APP_ROLE_PASSWORD = "leadgen_app_test_only";

declare module "vitest" {
  export interface ProvidedContext {
    testAdminUrl: string;
    testTemplateDatabase: string;
  }
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * Builds ONE migrated + seeded template database for the whole run. Test files clone it.
 * Migrations run as the owner; tests connect as the restricted application role, so a missing
 * GRANT fails a test here instead of failing in production.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Start a database (npm run db:local, or docker compose up -d db) and " +
        "set TEST_DATABASE_URL to an admin connection, e.g. postgres://postgres@127.0.0.1:54349/postgres",
    );
  }

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  // Serialise concurrent test runs (e.g. watch mode + CI) around role creation.
  await admin.query("select pg_advisory_lock(7242018)");
  const exists = await admin.query("select 1 from pg_roles where rolname = $1", [APP_ROLE]);
  if (exists.rowCount === 0) {
    await admin.query(`create role ${APP_ROLE} login nosuperuser nocreatedb nocreaterole noinherit`);
  }
  await admin.query(`alter role ${APP_ROLE} password '${APP_ROLE_PASSWORD}'`);
  await admin.query("select pg_advisory_unlock(7242018)");

  const template = `leadgen_tpl_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${template}"`);
  const templateUrl = withDatabase(adminUrl, template);

  await runner({
    databaseUrl: templateUrl,
    dir: path.join(root, "db/migrations"),
    direction: "up",
    migrationsTable: "pgmigrations",
    singleTransaction: true,
    log: () => undefined,
  });

  const seedDb = createDb({ url: templateUrl, poolMax: 2 });
  try {
    await seedReferenceData(seedDb, { brandName: "SparkQuote Local", includeDevPostcodes: true });
  } finally {
    await seedDb.destroy();
  }

  project.provide("testAdminUrl", adminUrl);
  project.provide("testTemplateDatabase", template);

  return async () => {
    await admin.query(`drop database if exists "${template}" with (force)`);
    await admin.end();
  };
}
