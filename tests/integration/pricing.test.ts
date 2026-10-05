import pino from "pino";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureOperator, type Operator } from "../../src/modules/inbox";
import { createPricingService, type LeadPricingFacts, type PricingRuleInput, type PricingService } from "../../src/modules/pricing";
import { endRulesWithScope, insertRule, lockPricingScope, pricingMoment } from "../../src/modules/pricing/repo";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let t: TestDatabase;
let pricing: PricingService;
let operator: Operator;
let verticalId: number;
let roofRepairId: number;
const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  t = await createTestDatabase();
  pricing = createPricingService({ db: t.db, logger: pino({ level: "silent" }), verticalSlug: "roofing" });
  operator = await ensureOperator(t.db, "pricing@example.com");
  verticalId = (await t.admin.selectFrom("verticals").select("id").where("slug", "=", "roofing").executeTakeFirstOrThrow()).id;
  roofRepairId = (await t.admin.selectFrom("service_types").select("id").where("slug", "=", "roof_repair").executeTakeFirstOrThrow()).id;
});
afterAll(async () => {
  await t.destroy();
});

const facts = (overrides: Partial<LeadPricingFacts> = {}): LeadPricingFacts => ({ verticalId, serviceTypeId: roofRepairId, postcodeOutward: "BR6", urgency: "within_2_weeks", saleType: "exclusive", ...overrides });
const rule = (overrides: Partial<PricingRuleInput> = {}): PricingRuleInput => ({ serviceSlug: null, serviceAreaSlug: null, urgency: null, saleType: "exclusive", pricePence: 3000, ...overrides });
const set = async (overrides: Partial<PricingRuleInput> = {}) => {
  const result = await pricing.setPrice({ operator, rule: rule(overrides), requestId: rid() });
  if (!result.ok) throw new Error(result.code);
  return result.id;
};
const price = async (overrides: Partial<LeadPricingFacts> = {}) => (await pricing.resolve(facts(overrides)))?.pricePence;
const reset = () => sql`delete from pricing_rules`.execute(t.admin).catch(() => sql`alter table pricing_rules disable trigger pricing_rules_guard`.execute(t.admin).then(() => sql`delete from pricing_rules`.execute(t.admin)));

describe("the most specific rule wins", () => {
  it("returns nothing when no rule matches: a human must supply the price", async () => {
    expect(await price()).toBeUndefined();
  });

  it("prefers a rule that names more of the lead's attributes", async () => {
    await set({ pricePence: 3000 }); // any service, anywhere, any urgency
    expect(await price()).toBe(3000);
    await set({ serviceSlug: "roof_repair", pricePence: 3500 });
    expect(await price()).toBe(3500);
    await set({ serviceAreaSlug: "orpington", pricePence: 3800 }); // anywhere-service, Orpington: 1 attribute, same as the service rule
    await set({ serviceSlug: "roof_repair", urgency: "within_2_weeks", pricePence: 4200 });
    expect(await price()).toBe(4200); // 2 attributes beats 1
    await set({ serviceSlug: "roof_repair", serviceAreaSlug: "orpington", urgency: "within_2_weeks", pricePence: 5000 });
    expect(await price()).toBe(5000); // 3 beats 2
    // Different facts fall back to less specific rules. The service-only and Orpington-only rules are equally specific (one
    // attribute each), so the NEWER one (Orpington, £38) wins; the any-service rule (£30) loses to both.
    expect(await price({ urgency: "emergency" })).toBe(3800);
    expect(await price({ urgency: "emergency", postcodeOutward: "BR1" })).toBe(3500); // outside Orpington: only the service rule is left
  });

  it("matches an area rule by the lead's postcode district, and only for that area", async () => {
    await reset();
    await set({ serviceAreaSlug: "orpington", pricePence: 3900 }); // Orpington = BR5, BR6
    await set({ pricePence: 3000 });
    expect(await price({ postcodeOutward: "BR6" })).toBe(3900);
    expect(await price({ postcodeOutward: "BR5" })).toBe(3900);
    expect(await price({ postcodeOutward: "BR1" })).toBe(3000); // Bromley: not in the Orpington rule
  });

  it("keeps exclusive and shared prices apart", async () => {
    await reset();
    await set({ saleType: "exclusive", pricePence: 4000 });
    await set({ saleType: "shared", pricePence: 1500 });
    expect(await price({ saleType: "exclusive" })).toBe(4000);
    expect(await price({ saleType: "shared" })).toBe(1500);
  });

  it("breaks ties by priority, then by the newest rule", async () => {
    await reset();
    const older = await set({ serviceSlug: "roof_repair", pricePence: 3100 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A second CURRENT rule of the same scope can only exist outside setPrice (which ends the old one); insert it directly.
    await t.admin.insertInto("pricing_rules").values({ vertical_id: verticalId, service_type_id: roofRepairId, sale_type: "exclusive", price_pence: 3200 }).execute();
    expect(await price()).toBe(3200); // newest wins
    await t.admin.updateTable("pricing_rules").set({ priority: 0 }).where("id", "=", older).execute().catch(() => undefined);
    await t.admin.insertInto("pricing_rules").values({ vertical_id: verticalId, service_type_id: roofRepairId, sale_type: "exclusive", price_pence: 3300, priority: 10 }).execute();
    expect(await price()).toBe(3300); // higher priority beats newer
  });

  it("ignores rules that have ended or have not started yet", async () => {
    await reset();
    await t.admin.insertInto("pricing_rules").values({ vertical_id: verticalId, sale_type: "exclusive", price_pence: 9999, valid_during: sql`tstzrange(now() - interval '2 days', now() - interval '1 day')` as never }).execute();
    await t.admin.insertInto("pricing_rules").values({ vertical_id: verticalId, sale_type: "exclusive", price_pence: 8888, valid_during: sql`tstzrange(now() + interval '1 day', null)` as never }).execute();
    expect(await price()).toBeUndefined();
    await set({ pricePence: 3000 });
    expect(await price()).toBe(3000);
    // Asked about the past or future, history answers correctly.
    expect((await pricing.resolve(facts(), new Date(Date.now() - 36 * 3_600_000)))?.pricePence).toBe(9999);
    expect((await pricing.resolve(facts(), new Date(Date.now() + 36 * 3_600_000)))?.pricePence).toBe(8888);
  });
});

describe("setting a price replaces the old one without losing it", () => {
  it("ends the current rule for the scope, keeps it in the history, and audits the change", async () => {
    await reset();
    const first = await set({ serviceSlug: "roof_repair", pricePence: 3500 });
    const second = await set({ serviceSlug: "roof_repair", pricePence: 3900 });
    expect(await price()).toBe(3900);

    const rows = await t.admin.selectFrom("pricing_rules").select(["id", "price_pence"]).select(sql<boolean>`upper(valid_during) is null`.as("current")).orderBy("created_at").execute();
    expect(rows).toEqual([{ id: first, price_pence: 3500, current: false }, { id: second, price_pence: 3900, current: true }]);
    const entry = (await t.admin.selectFrom("audit_logs").selectAll().where("entity_id", "=", second).executeTakeFirstOrThrow());
    expect(entry).toMatchObject({ action: "pricing.rule_created", actor_id: operator.id });
    expect(entry.before).toEqual({ ended_rules: [{ id: first, price_pence: 3500 }] });
    expect(entry.after).toMatchObject({ service: "roof_repair", price_pence: 3900, sale_type: "exclusive" });
  });

  it("leaves other scopes alone", async () => {
    await reset();
    await set({ serviceSlug: "roof_repair", pricePence: 3500 });
    await set({ serviceSlug: "flat_roof", pricePence: 5500 });
    await set({ serviceSlug: "roof_repair", pricePence: 3700 });
    const current = await t.admin.selectFrom("pricing_rules").select("price_pence").where(sql<boolean>`upper(valid_during) is null`).orderBy("price_pence").execute();
    expect(current.map((row) => row.price_pence)).toEqual([3700, 5500]);
  });

  it("RACE: a change whose transaction began BEFORE a committed one still ends it (the clock is read after the lock, not at BEGIN)", async () => {
    await reset();
    const scope = { verticalId, serviceTypeId: roofRepairId, serviceAreaId: null, urgency: null, saleType: "exclusive" as const };
    await t.db.transaction().execute(async (early) => {
      await sql`select now()`.execute(early); // this transaction's now() is fixed here...
      await new Promise((resolve) => setTimeout(resolve, 30));
      await set({ serviceSlug: "roof_repair", pricePence: 3100 }); // ...and a later one commits a rule first
      await lockPricingScope(early, scope);
      const at = await pricingMoment(early);
      const ended = await endRulesWithScope(early, scope, at);
      expect(ended).toHaveLength(1);
      await insertRule(early, { ...scope, pricePence: 3200, createdBy: operator.id }, at);
    });
    const current = await t.admin.selectFrom("pricing_rules").select("price_pence").where(sql<boolean>`upper(valid_during) is null`).execute();
    expect(current).toEqual([{ price_pence: 3200 }]);
  });

  it("RACE: 8 simultaneous price changes for one scope leave exactly one current rule", async () => {
    await reset();
    await Promise.all(Array.from({ length: 8 }, (_, i) => pricing.setPrice({ operator, rule: rule({ serviceSlug: "roof_repair", pricePence: 3000 + i }), requestId: rid() })));
    const current = await t.admin.selectFrom("pricing_rules").select("id").where(sql<boolean>`upper(valid_during) is null`).execute();
    expect(current).toHaveLength(1);
    expect((await t.admin.selectFrom("pricing_rules").select("id").execute())).toHaveLength(8); // nothing lost
  });

  it("refuses unknown services and areas", async () => {
    expect(await pricing.setPrice({ operator, rule: rule({ serviceSlug: "moon_roofing" }), requestId: rid() })).toEqual({ ok: false, code: "unknown_service" });
    expect(await pricing.setPrice({ operator, rule: rule({ serviceAreaSlug: "narnia" }), requestId: rid() })).toEqual({ ok: false, code: "unknown_area" });
  });
});

describe("ending a rule", () => {
  it("ends a current rule once, audits it, and refuses an unknown or already-ended one", async () => {
    await reset();
    const id = await set({ pricePence: 3000 });
    expect(await pricing.end({ operator, ruleId: id, requestId: rid() })).toEqual({ ok: true });
    expect(await price()).toBeUndefined();
    expect(await pricing.end({ operator, ruleId: id, requestId: rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await pricing.end({ operator, ruleId: crypto.randomUUID(), requestId: rid() })).toEqual({ ok: false, code: "not_found" });
    expect((await t.admin.selectFrom("audit_logs").select(["action", "before"]).where("entity_id", "=", id).where("action", "=", "pricing.rule_ended").executeTakeFirstOrThrow()).before).toEqual({ price_pence: 3000 });
  });

  it("lists rules with current ones first and says which are ended", async () => {
    await reset();
    const old = await set({ serviceSlug: "roof_repair", pricePence: 3500 });
    await set({ serviceSlug: "roof_repair", pricePence: 3900 });
    const { rules } = await pricing.list();
    expect(rules.map((entry) => [entry.pricePence, entry.state])).toEqual([[3900, "current"], [3500, "ended"]]);
    expect(rules.find((entry) => entry.id === old)!.validTo).toBeInstanceOf(Date);
  });
});
