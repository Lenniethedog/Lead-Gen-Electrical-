import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsent, buildShareWithOneBusinessConsent } from "../../src/config/consent";
import { SERVICE_SLUGS, SERVICES, ROOFING } from "../../src/config/verticals/roofing";
import { SOURCE_SLUGS } from "../../src/modules/attribution";
import { ConsentArchiveMismatchError, ensureConsentText, findActiveConsentText } from "../../src/modules/consent";
import { DEV_POSTCODES } from "../../db/seeds/dev-postcodes";
import { seedReferenceData } from "../../db/seeds/reference-data";
import { SERVICE_AREAS } from "../../db/seeds/service-areas";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

describe("seeded reference data matches the code that depends on it (drift guard)", () => {
  it("has every service the form offers, with matching labels", async () => {
    const rows = await t.admin
      .selectFrom("service_types as s")
      .innerJoin("verticals as v", "v.id", "s.vertical_id")
      .select(["s.slug", "s.label", "s.active"])
      .where("v.slug", "=", ROOFING.slug)
      .execute();
    expect(rows.map((r) => r.slug).sort()).toEqual([...SERVICE_SLUGS].sort());
    for (const row of rows) {
      expect(row.label).toBe(SERVICES[row.slug as keyof typeof SERVICES].label);
      expect(row.active).toBe(true);
    }
  });

  it("has every lead source the attribution classifier can return", async () => {
    const rows = await t.admin.selectFrom("lead_sources").select("slug").execute();
    expect(rows.map((r) => r.slug).sort()).toEqual([...SOURCE_SLUGS].sort());
  });

  it("matches the vertical's duplicate window to the config", async () => {
    const row = await t.admin.selectFrom("verticals").select("duplicate_window_days").where("slug", "=", ROOFING.slug).executeTakeFirstOrThrow();
    expect(row.duplicate_window_days).toBe(ROOFING.duplicateWindowDays);
  });

  it("loads the whole launch footprint and enables it for the vertical", async () => {
    const rows = await t.admin
      .selectFrom("vertical_service_areas as vsa")
      .innerJoin("service_area_districts as d", "d.service_area_id", "vsa.service_area_id")
      .select("d.outward")
      .where("vsa.active", "=", true)
      .execute();
    const expected = SERVICE_AREAS.flatMap((area) => [...area.districts]);
    expect(rows.map((r) => r.outward).sort()).toEqual(expected.sort());
  });

  it("covers every synthetic dev postcode with a district inside the footprint", async () => {
    const footprint = new Set<string>(SERVICE_AREAS.flatMap((area) => [...area.districts]));
    for (const { postcode } of DEV_POSTCODES) {
      expect(footprint.has(postcode.split(" ")[0] ?? "")).toBe(true);
    }
  });
});

describe("seeding is idempotent and respects operator decisions", () => {
  it("can run repeatedly without changing the result", async () => {
    const before = await t.admin.selectFrom("service_types").select("id").orderBy("id").execute();
    const a = await seedReferenceData(t.admin, { brandName: "RoofQuote Local", includeDevPostcodes: true });
    const b = await seedReferenceData(t.admin, { brandName: "RoofQuote Local", includeDevPostcodes: true });
    expect(a).toEqual(b);
    expect(await t.admin.selectFrom("service_types").select("id").orderBy("id").execute()).toEqual(before);
  });

  it("never re-activates a service an operator switched off", async () => {
    await t.admin.updateTable("service_types").set({ active: false }).where("slug", "=", "chimney").execute();
    await seedReferenceData(t.admin, { brandName: "RoofQuote Local", includeDevPostcodes: false });
    const row = await t.admin.selectFrom("service_types").select("active").where("slug", "=", "chimney").executeTakeFirstOrThrow();
    expect(row.active).toBe(false);
  });
});

describe("consent archive", () => {
  it("refuses to run if published wording would silently change (e.g. a different brand name)", async () => {
    await expect(ensureConsentText(t.admin, buildConsent("A Different Brand"))).rejects.toBeInstanceOf(ConsentArchiveMismatchError);
  });

  it("publishes a new version, retires the old one, and makes the new one active", async () => {
    const v1 = await findActiveConsentText(t.admin, "share_with_business");
    expect(v1?.version).toBe("v1");

    const v2 = { ...buildShareWithOneBusinessConsent("RoofQuote Local"), version: "v2", body: "Version two wording that is long enough to be valid." , segments: [] };
    await ensureConsentText(t.admin, v2);

    expect((await findActiveConsentText(t.admin, "share_with_business"))?.version).toBe("v2");
    const retired = await t.admin.selectFrom("consent_texts").select(["version", "retired_at"]).where("version", "=", "v1").executeTakeFirstOrThrow();
    expect(retired.retired_at).not.toBeNull();
  });
});
