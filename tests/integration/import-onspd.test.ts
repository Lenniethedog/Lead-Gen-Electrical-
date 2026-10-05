import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");
const tsx = path.join(root, "node_modules/.bin/tsx");

let t: TestDatabase;
let dir: string;
let goodFile: string;

const HEADER = "pcd,pcd2,pcds,dointr,doterm,usertype,oseast1m,osnrth1m,lat,long,lad25cd,rgn25cd,ctry25cd";
const csv = (rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

beforeAll(async () => {
  t = await createTestDatabase();
  dir = await mkdtemp(path.join(os.tmpdir(), "onspd-test-"));
  goodFile = path.join(dir, "ONSPD_TEST_UK.csv");
  await writeFile(
    goodFile,
    csv([
      'BR60AA ,BR6 0AA,BR6 0AA,198001,,0,545000,164000,51.373000,0.099700,E09000006,E12000007,E92000001', // live, in BR
      'BR60AB ,BR6 0AB,BR6 0AB,198001,201012,0,545100,164100,51.373500,0.100000,E09000006,E12000007,E92000001', // terminated
      "TN131AA,TN13 1AA,TN13 1AA,198001,,0,552000,155000,51.272400,0.190500,E07000111,E12000008,E92000001", // live, in TN
      "BR60AC ,BR6 0AC,BR6 0AC,198001,,0,0,0,99.999999,0.000000,E09000006,E12000007,E92000001", // no grid reference
      "SW1A1AA,SW1A 1AA,SW1A 1AA,198001,,0,529000,179000,51.501000,-0.141600,E09000033,E12000007,E92000001", // outside --areas
      "NOTAPC ,NOT APC,NOT A PC,198001,,0,0,0,0,0,,,", // junk row
    ]),
  );
});
afterAll(async () => {
  await t.destroy();
  await rm(dir, { recursive: true, force: true });
});

async function importer(args: string[]) {
  return run(tsx, [path.join(root, "scripts/import-onspd.ts"), ...args], {
    cwd: root,
    env: { ...process.env, DATABASE_MIGRATION_URL: t.ownerUrl, DATABASE_URL: t.ownerUrl, APP_ENV: "test" },
  });
}

async function importerFailure(args: string[]) {
  try {
    await importer(args);
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
  throw new Error("expected the importer to fail");
}

const count = async () =>
  Number((await t.admin.selectFrom("postcodes").select((eb) => eb.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);

describe("scripts/import-onspd.ts", () => {
  it("--dry-run reads and counts but writes nothing", async () => {
    const before = await count();
    const { stdout } = await importer([goodFile, "--dry-run"]);
    expect(stdout).toContain("DRY RUN");
    expect(stdout).toContain("read 6 rows");
    expect(await count()).toBe(before);
  });

  it("imports only the requested areas, keeps terminated and un-located postcodes, skips junk", async () => {
    const { stdout } = await importer([goodFile, "--areas", "BR,TN", "--edition", "2026-08"]);
    expect(stdout).toContain("upserted 4");
    expect(stdout).toContain("1 terminated");
    expect(stdout).toContain("1 without coordinates");
    expect(stdout).toContain("skipped 1 invalid and 1 outside --areas");

    const row = await t.admin.selectFrom("postcodes").selectAll().where("postcode", "=", "BR6 0AB").executeTakeFirstOrThrow();
    expect(row).toMatchObject({ outward: "BR6", sector: "BR6 0", area: "BR", admin_district_code: "E09000006", source: "onspd:2026-08" });
    expect(row.terminated_on).not.toBeNull();

    const unlocated = await t.admin.selectFrom("postcodes").select(["lat", "lng"]).where("postcode", "=", "BR6 0AC").executeTakeFirstOrThrow();
    expect(unlocated).toEqual({ lat: null, lng: null });

    // SW1A 1AA is in the file but outside --areas: the pre-existing synthetic row must be left untouched.
    const outside = await t.admin.selectFrom("postcodes").select("source").where("postcode", "=", "SW1A 1AA").executeTakeFirstOrThrow();
    expect(outside.source).toBe("dev-synthetic");
  });

  it("REPLACES synthetic development rows with the real ones, and re-running changes nothing", async () => {
    const synthetic = await t.admin.selectFrom("postcodes").select(["source"]).where("postcode", "=", "BR6 0AA").executeTakeFirstOrThrow();
    expect(synthetic.source).toBe("onspd:2026-08"); // the first import above already replaced the dev-synthetic BR6 0AA

    const before = await count();
    await importer([goodFile, "--areas", "BR,TN", "--edition", "2026-08"]);
    expect(await count()).toBe(before);
  });

  it("refuses a file that is not an ONSPD extract, before writing anything", async () => {
    const wrong = path.join(dir, "not-onspd.csv");
    await writeFile(wrong, "postcode,latitude,longitude\nBR6 0AA,51.3,0.1\n");
    const before = await count();
    const { code, output } = await importerFailure([wrong]);
    expect(code).toBe(1);
    expect(output).toContain("does not look like an ONSPD CSV");
    expect(await count()).toBe(before);
  });

  it("stops early when the 'postcode' column is full of non-postcodes", async () => {
    const junk = path.join(dir, "junk.csv");
    await writeFile(junk, csv(Array.from({ length: 25_000 }, (_, i) => `x${i},x,NOT A PC ${i},198001,,0,0,0,51.3,0.1,,,`)));
    const before = await count();
    const { code, output } = await importerFailure([junk]);
    expect(code).toBe(1);
    expect(output).toContain("not valid UK postcodes");
    expect(await count()).toBe(before);
  });

  it("reports a missing file clearly", async () => {
    const { code, output } = await importerFailure([path.join(dir, "missing.csv")]);
    expect(code).toBe(2);
    expect(output).toContain("File not found");
  });
});
