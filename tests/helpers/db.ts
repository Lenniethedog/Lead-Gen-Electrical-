import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { inject } from "vitest";
import { createDb, type Database } from "../../src/lib/db/client";
import { APP_ROLE, APP_ROLE_PASSWORD } from "../setup/postgres";

export interface TestDatabase {
  /** Connected as the restricted application role - exactly what production uses. */
  db: Database;
  /** Connected as the owner: for arranging fixtures the application role may not write. */
  admin: Database;
  name: string;
  /** Owner connection string for this database (for subprocesses such as CLI scripts under test). */
  ownerUrl: string;
  /** Restricted-role connection string (what production uses): for subprocesses that must run as the app, e.g. the worker. */
  appUrl: string;
  destroy(): Promise<void>;
}

function urlFor(adminUrl: string, database: string, credentials?: { user: string; password: string }): string {
  const parsed = new URL(adminUrl);
  parsed.pathname = `/${database}`;
  if (credentials) {
    parsed.username = credentials.user;
    parsed.password = credentials.password;
  }
  return parsed.toString();
}

/** A private database for one test file, cloned from the migrated + seeded template. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = inject("testAdminUrl");
  const template = inject("testTemplateDatabase");
  const name = `leadgen_test_${randomBytes(6).toString("hex")}`;

  const control = new Client({ connectionString: adminUrl });
  await control.connect();
  try {
    await control.query(`create database "${name}" template "${template}"`);
  } finally {
    await control.end();
  }

  const appUrl = urlFor(adminUrl, name, { user: APP_ROLE, password: APP_ROLE_PASSWORD });
  const db = createDb({ url: appUrl, poolMax: 10 });
  const admin = createDb({ url: urlFor(adminUrl, name), poolMax: 2 });

  return {
    db,
    admin,
    name,
    ownerUrl: urlFor(adminUrl, name),
    appUrl,
    async destroy() {
      await db.destroy();
      await admin.destroy();
      const cleanup = new Client({ connectionString: adminUrl });
      await cleanup.connect();
      try {
        await cleanup.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
