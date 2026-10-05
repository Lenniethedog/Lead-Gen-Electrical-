import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClientService, type ClientService, type CoverageRuleInput } from "../../src/modules/clients";
import { explainCoverage, findEligibleClients, type CoverageQuery } from "../../src/modules/coverage";
import { ensureOperator, type Operator } from "../../src/modules/inbox";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawClient } from "../helpers/raw";

/**
 * Coverage: which clients may receive a lead. The scenarios come from the original design test of the query (now `findEligibleClients`);
 * the property test proves the tester screen (explainCoverage) can never disagree with the query routing will use.
 */
let t: TestDatabase;
let clients: ClientService;
let operator: Operator;
let verticalId: number;
let roofRepairId: number;
let flatRoofId: number;
const requestId = () => `req-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  t = await createTestDatabase();
  clients = createClientService({ db: t.db, logger: pino({ level: "silent" }), verticalSlug: "roofing" });
  operator = await ensureOperator(t.db, "coverage@example.com");
  verticalId = (await t.admin.selectFrom("verticals").select("id").where("slug", "=", "roofing").executeTakeFirstOrThrow()).id;
  roofRepairId = (await t.admin.selectFrom("service_types").select("id").where("slug", "=", "roof_repair").executeTakeFirstOrThrow()).id;
  flatRoofId = (await t.admin.selectFrom("service_types").select("id").where("slug", "=", "flat_roof").executeTakeFirstOrThrow()).id;
});
afterAll(async () => {
  await t.destroy();
});

const query = (overrides: Partial<CoverageQuery> = {}): CoverageQuery => ({ postcode: "BR6 0AA", verticalId, serviceTypeId: roofRepairId, saleType: "exclusive", ...overrides });

async function makeClient(
  name: string,
  options: { status?: "prospect" | "active" | "paused"; acceptsExclusive?: boolean; services?: string[]; rules?: CoverageRuleInput[] } = {},
): Promise<string> {
  const raw = await insertRawClient(t.admin, { name, status: "prospect" });
  await t.admin
    .updateTable("clients")
    .set({ accepts_exclusive: options.acceptsExclusive ?? true, accepts_shared: true })
    .where("id", "=", raw.id)
    .execute();
  await clients.setServices({ operator, clientId: raw.id, serviceSlugs: options.services ?? ["roof_repair"], requestId: requestId() });
  for (const rule of options.rules ?? []) {
    const result = await clients.addRule({ operator, clientId: raw.id, rule, requestId: requestId() });
    // (The random generator below may produce the same rule twice; the unique index correctly refuses the repeat.)
    if (!result.ok && result.code !== "duplicate_rule") throw new Error(`could not add rule ${JSON.stringify(rule)}: ${result.code}`);
  }
  if ((options.status ?? "active") !== "prospect") {
    await t.admin.updateTable("clients").set({ status: options.status ?? "active" }).where("id", "=", raw.id).execute();
  }
  return raw.id;
}

const eligibleIds = async (q: CoverageQuery) => new Set((await findEligibleClients(t.db, q)).map((client) => client.id));
const include = (rule: Record<string, unknown>): CoverageRuleInput => ({ mode: "include", ...rule }) as CoverageRuleInput;
const exclude = (rule: Record<string, unknown>): CoverageRuleInput => ({ mode: "exclude", ...rule }) as CoverageRuleInput;

/** Great-circle distance in metres, the same formula the query uses. */
function haversine(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

describe("which clients may receive a lead", () => {
  it("applies every rule kind, excludes, status, service and offer type correctly", async () => {
    const byOutward = await makeClient("outward", { rules: [include({ kind: "outward", outward: "BR6" })] });
    const bySector = await makeClient("sector", { rules: [include({ kind: "sector", sector: "BR6 0" })] });
    const byPrefix = await makeClient("prefix", { rules: [include({ kind: "postcode_prefix", postcodePrefix: "BR6 0A" })] });
    const byArea = await makeClient("area", { rules: [include({ kind: "area", serviceAreaSlug: "orpington" })] });
    const byRadiusIn = await makeClient("radius 15km", { rules: [include({ kind: "radius", centerPostcode: "TN13 1AA", radiusMetres: 15_000 })] });
    const byRadiusOut = await makeClient("radius 10km", { rules: [include({ kind: "radius", centerPostcode: "TN13 1AA", radiusMetres: 10_000 })] });
    const excluded = await makeClient("excluded", { rules: [include({ kind: "outward", outward: "BR6" }), exclude({ kind: "sector", sector: "BR6 0" })] });
    const wrongPlace = await makeClient("wrong place", { rules: [include({ kind: "outward", outward: "TN13" })] });
    const paused = await makeClient("paused", { status: "paused", rules: [include({ kind: "outward", outward: "BR6" })] });
    const noService = await makeClient("no service", { services: ["flat_roof"], rules: [include({ kind: "outward", outward: "BR6" })] });
    const sharedOnly = await makeClient("shared only", { acceptsExclusive: false, rules: [include({ kind: "outward", outward: "BR6" })] });

    const expectedExclusive = new Set([byOutward, bySector, byPrefix, byArea, byRadiusIn]);
    expect(await eligibleIds(query())).toEqual(expectedExclusive);
    // For a SHARED lead the shared-only client becomes eligible too.
    expect(await eligibleIds(query({ saleType: "shared" }))).toEqual(new Set([...expectedExclusive, sharedOnly]));
    // A different service changes who qualifies.
    expect(await eligibleIds(query({ serviceTypeId: flatRoofId }))).toEqual(new Set([noService]));

    // The tester says why, for each of them, and agrees with the query.
    const explanation = await explainCoverage(t.db, query());
    if (explanation.status !== "ok") throw new Error("expected a known postcode");
    const verdict = (id: string) => explanation.clients.find((client) => client.clientId === id)!;
    expect(new Set(explanation.clients.filter((client) => client.eligible).map((client) => client.clientId))).toEqual(expectedExclusive);
    expect(verdict(paused).reasons).toEqual(["client_not_active"]);
    expect(verdict(noService).reasons).toEqual(["service_not_offered"]);
    expect(verdict(sharedOnly).reasons).toEqual(["sale_type_not_accepted"]);
    expect(verdict(excluded).reasons).toEqual(["excluded_by_rule"]);
    expect(verdict(excluded).matchedRules.map((rule) => [rule.mode, rule.label])).toEqual([["include", "Postcode district BR6"], ["exclude", "Postcode sector BR6 0"]]);
    expect(verdict(wrongPlace).reasons).toEqual(["no_include_rule_matches"]);
    expect(verdict(byRadiusOut).reasons).toEqual(["no_include_rule_matches"]);
    expect(verdict(byArea).matchedRules.map((rule) => rule.label)).toEqual(["Area: Orpington"]);
  });

  it("lists EVERY failing reason, not just the first", async () => {
    const id = await makeClient("everything wrong", { status: "paused", services: ["flat_roof"], acceptsExclusive: false, rules: [include({ kind: "outward", outward: "TN13" })] });
    const explanation = await explainCoverage(t.db, query(), { clientId: id });
    if (explanation.status !== "ok") throw new Error("unexpected");
    expect(explanation.clients).toHaveLength(1);
    expect(explanation.clients[0]!.reasons).toEqual(["client_not_active", "service_not_offered", "sale_type_not_accepted", "no_include_rule_matches"]);
  });

  it("an unknown postcode yields no candidates and an 'unknown' explanation rather than an error", async () => {
    expect(await findEligibleClients(t.db, query({ postcode: "ZZ99 9ZZ" }))).toEqual([]);
    expect(await explainCoverage(t.db, query({ postcode: "ZZ99 9ZZ" }))).toEqual({ status: "unknown_postcode" });
  });

  it("ignores deleted clients and deactivated rules", async () => {
    const gone = await makeClient("deleted", { rules: [include({ kind: "outward", outward: "BR6" })] });
    const inactive = await makeClient("inactive rule", { rules: [include({ kind: "outward", outward: "BR6" })] });
    expect((await eligibleIds(query())).has(gone)).toBe(true);
    await t.admin.updateTable("clients").set({ deleted_at: new Date() }).where("id", "=", gone).execute();
    await t.admin.updateTable("client_service_areas").set({ active: false }).where("client_id", "=", inactive).execute();
    const after = await eligibleIds(query());
    expect(after.has(gone)).toBe(false);
    expect(after.has(inactive)).toBe(false);
  });
});

describe("radius rules are exact at the boundary", () => {
  it("includes a postcode at the radius and excludes one metre beyond (distance computed independently)", async () => {
    const centre = await t.admin.selectFrom("postcodes").select(["lat", "lng"]).where("postcode", "=", "TN13 1AA").executeTakeFirstOrThrow();
    const lead = await t.admin.selectFrom("postcodes").select(["lat", "lng"]).where("postcode", "=", "BR6 0AA").executeTakeFirstOrThrow();
    const metres = haversine({ lat: centre.lat!, lng: centre.lng! }, { lat: lead.lat!, lng: lead.lng! });
    expect(metres).toBeGreaterThan(10_000);
    expect(metres).toBeLessThan(15_000);

    const justInside = await makeClient("just inside", { rules: [include({ kind: "radius", centerPostcode: "TN13 1AA", radiusMetres: Math.ceil(metres) + 1 })] });
    const justOutside = await makeClient("just outside", { rules: [include({ kind: "radius", centerPostcode: "TN13 1AA", radiusMetres: Math.floor(metres) - 1 })] });
    const eligible = await eligibleIds(query());
    expect(eligible.has(justInside)).toBe(true);
    expect(eligible.has(justOutside)).toBe(false);
  });

  it("a postcode without coordinates matches no radius rule, and does not break the query", async () => {
    await t.admin.insertInto("postcodes").values({ postcode: "BR9 9ZZ" }).execute(); // no lat/lng: both-or-neither CHECK allows it
    const radius = await makeClient("radius only", { rules: [include({ kind: "radius", centerPostcode: "TN13 1AA", radiusMetres: 100_000 })] });
    const district = await makeClient("district", { rules: [include({ kind: "outward", outward: "BR9" })] });
    const result = await eligibleIds(query({ postcode: "BR9 9ZZ" }));
    expect(result.has(radius)).toBe(false);
    expect(result.has(district)).toBe(true);
    const explanation = await explainCoverage(t.db, query({ postcode: "BR9 9ZZ" }));
    expect(explanation).toMatchObject({ status: "ok", hasCoordinates: false });
  });
});

describe("the tester can never disagree with the query routing uses (property test)", () => {
  /** Small seeded PRNG so a failure is reproducible from the printed seed. */
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let r = Math.imul(a ^ (a >>> 15), 1 | a);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("agrees for 60 random clients, every dev postcode, both sale types and two services", async () => {
    const seed = 20261005;
    const random = mulberry32(seed);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const outwards = ["BR1", "BR2", "BR3", "BR4", "BR5", "BR6", "BR7", "BR8", "DA1", "DA11", "TN13", "TN14"];
    const postcodes = (await t.admin.selectFrom("postcodes").select("postcode").where("source", "=", "dev").execute().catch(() => [])).map((row) => row.postcode);
    const targets = postcodes.length > 0 ? postcodes : ["BR1 1AA", "BR2 0AA", "BR3 1AA", "BR4 0AA", "BR5 1AA", "BR6 0AA", "BR7 5AA", "BR8 7AA", "DA1 1AA", "DA11 0AA", "TN13 1AA", "TN14 5AA"];
    const areas = ["orpington", "bromley", "sevenoaks", "dartford", "gravesend"];

    for (let i = 0; i < 60; i += 1) {
      const rules: CoverageRuleInput[] = [];
      const ruleCount = 1 + Math.floor(random() * 4);
      for (let r = 0; r < ruleCount; r += 1) {
        const mode = random() < 0.25 ? "exclude" : "include";
        switch (pick(["outward", "sector", "prefix", "area", "radius"] as const)) {
          case "outward": rules.push({ mode, kind: "outward", outward: pick(outwards) }); break;
          case "sector": rules.push({ mode, kind: "sector", sector: `${pick(outwards)} ${Math.floor(random() * 3)}` }); break;
          case "prefix": rules.push({ mode, kind: "postcode_prefix", postcodePrefix: pick(["BR", "DA", "TN1", "BR6"]) }); break;
          case "area": rules.push({ mode, kind: "area", serviceAreaSlug: pick(areas) }); break;
          case "radius": rules.push({ mode, kind: "radius", centerPostcode: pick(targets), radiusMetres: 500 + Math.floor(random() * 30_000) }); break;
        }
      }
      await makeClient(`random ${i}`, {
        status: random() < 0.8 ? "active" : pick(["paused", "prospect"] as const),
        acceptsExclusive: random() < 0.8,
        services: random() < 0.15 ? ["flat_roof"] : random() < 0.2 ? ["roof_repair", "flat_roof"] : ["roof_repair"],
        rules,
      });
    }

    let comparisons = 0;
    for (const postcode of targets) {
      for (const saleType of ["exclusive", "shared"] as const) {
        for (const serviceTypeId of [roofRepairId, flatRoofId]) {
          const q = query({ postcode, saleType, serviceTypeId });
          const fromQuery = await eligibleIds(q);
          const explanation = await explainCoverage(t.db, q);
          if (explanation.status !== "ok") throw new Error(`postcode ${postcode} unknown`);
          const fromTester = new Set(explanation.clients.filter((client) => client.eligible).map((client) => client.clientId));
          expect(fromTester, `seed ${seed}, ${postcode}, ${saleType}, service ${serviceTypeId}`).toEqual(fromQuery);
          // An ineligible client always has at least one stated reason; an eligible one has none.
          for (const client of explanation.clients) expect(client.reasons.length === 0).toBe(client.eligible);
          comparisons += 1;
        }
      }
    }
    expect(comparisons).toBe(targets.length * 4);
  });
});
