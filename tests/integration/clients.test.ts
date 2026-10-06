import pino from "pino";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClientService, parseClientInput, type ClientInput, type ClientService } from "../../src/modules/clients";
import { ensureOperator, type Operator } from "../../src/modules/inbox";
import { createTestDatabase, type TestDatabase } from "../helpers/db";

let t: TestDatabase;
let clients: ClientService;
let alice: Operator;
const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  t = await createTestDatabase();
  clients = createClientService({ db: t.db, logger: pino({ level: "silent" }), verticalSlug: "electrical" });
  alice = await ensureOperator(t.db, "alice@example.com");
});
afterAll(async () => {
  await t.destroy();
});

function input(overrides: Record<string, string> = {}): ClientInput {
  const parsed = parseClientInput({ name: "Dave's Electrical", contactEmail: "dave@example.com", acceptsExclusive: "on", ...overrides });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.value;
}
const create = async (overrides: Record<string, string> = {}) => (await clients.create({ operator: alice, client: input(overrides), requestId: rid() })).id;
const auditFor = (id: string) => t.admin.selectFrom("audit_logs").selectAll().where("entity_id", "=", id).orderBy("id").execute();

/** A client that is ready to go active: one service and one include rule. */
async function readyClient(name = "Ready Electrical") {
  const id = await create({ name });
  await clients.setServices({ operator: alice, clientId: id, serviceSlugs: ["fault_repair"], requestId: rid() });
  await clients.addRule({ operator: alice, clientId: id, rule: { mode: "include", kind: "outward", outward: "BR6" }, requestId: rid() });
  return id;
}

describe("creating and editing a client", () => {
  it("creates a prospect and records who did it", async () => {
    const id = await create({ contactPhone: "07911 123456" });
    const detail = (await clients.detail(id))!;
    expect(detail).toMatchObject({ name: "Dave's Electrical", status: "prospect", contactEmail: "dave@example.com", contactPhone: "+447911123456", acceptsExclusive: true, acceptsShared: false });
    const [entry] = await auditFor(id);
    expect(entry).toMatchObject({ actor_type: "staff_user", actor_id: alice.id, action: "client.created", entity_type: "client" });
    expect(entry!.after).toMatchObject({ name: "Dave's Electrical", status: "prospect", contact_email: "dave@example.com" });
  });

  it("edits details and audits the before and after", async () => {
    const id = await create();
    expect(await clients.update({ operator: alice, clientId: id, client: input({ name: "Dave & Sons Electrical", contactEmail: "office@daves.example" }), requestId: "req-edit" })).toEqual({ ok: true });
    expect((await clients.detail(id))!).toMatchObject({ name: "Dave & Sons Electrical", contactEmail: "office@daves.example" });
    const entry = (await auditFor(id)).at(-1)!;
    expect(entry).toMatchObject({ action: "client.updated", request_id: "req-edit" });
    expect(entry.before).toMatchObject({ name: "Dave's Electrical", contact_email: "dave@example.com" });
    expect(entry.after).toMatchObject({ name: "Dave & Sons Electrical", contact_email: "office@daves.example" });
  });

  it("reports an unknown client rather than inventing one", async () => {
    const ghost = crypto.randomUUID();
    expect(await clients.update({ operator: alice, clientId: ghost, client: input(), requestId: rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await clients.detail(ghost)).toBeUndefined();
    expect(await clients.setServices({ operator: alice, clientId: ghost, serviceSlugs: ["fault_repair"], requestId: rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await clients.addRule({ operator: alice, clientId: ghost, rule: { mode: "include", kind: "outward", outward: "BR6" }, requestId: rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await clients.setStatus({ operator: alice, clientId: ghost, status: "active", requestId: rid() })).toEqual({ ok: false, code: "not_found" });
  });

  it("lists clients with their counts, active ones first", async () => {
    const ready = await readyClient("Zed Active");
    await clients.setStatus({ operator: alice, clientId: ready, status: "active", requestId: rid() });
    await create({ name: "Alpha Prospect" });
    const list = await clients.list();
    const names = list.map((client) => client.name);
    expect(names.indexOf("Zed Active")).toBeLessThan(names.indexOf("Alpha Prospect"));
    expect(list.find((client) => client.id === ready)).toMatchObject({ status: "active", services: 1, includeRules: 1, activeLeads: 0 });
  });
});

describe("status: an active client must be able to receive a lead", () => {
  it("refuses to activate a client with no service or no include rule, and says why in the audit only when it works", async () => {
    const id = await create();
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() })).toEqual({ ok: false, code: "not_ready" });
    await clients.setServices({ operator: alice, clientId: id, serviceSlugs: ["fault_repair"], requestId: rid() });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() })).toEqual({ ok: false, code: "not_ready" });
    await clients.addRule({ operator: alice, clientId: id, rule: { mode: "exclude", kind: "outward", outward: "BR6" }, requestId: rid() });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() })).toEqual({ ok: false, code: "not_ready" }); // an EXCLUDE rule alone covers nowhere
    await clients.addRule({ operator: alice, clientId: id, rule: { mode: "include", kind: "outward", outward: "BR5" }, requestId: rid() });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() })).toEqual({ ok: true });
    expect((await auditFor(id)).filter((entry) => entry.action === "client.status_changed")).toHaveLength(1);
  });

  it("needs a reason from the closed list to pause, suspend or end a client", async () => {
    const id = await readyClient();
    await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "paused", requestId: rid() })).toEqual({ ok: false, code: "reason_required" });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "paused", reason: "call me on 07911 123456", requestId: rid() })).toEqual({ ok: false, code: "invalid_reason" });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "paused", reason: "paused_by_client", requestId: rid() })).toEqual({ ok: true });
    const entry = (await auditFor(id)).at(-1)!;
    expect(entry).toMatchObject({ action: "client.status_changed", reason: "paused_by_client", before: { status: "active" }, after: { status: "paused" } });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "paused", reason: "paused_by_client", requestId: rid() })).toEqual({ ok: false, code: "same_status" });
    // Reviving needs no reason (but a given one must still be from the list).
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "active", reason: "free text", requestId: rid() })).toEqual({ ok: false, code: "invalid_reason" });
    expect(await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() })).toEqual({ ok: true });
  });
});

describe("services", () => {
  it("replaces the set, rejects unknown services, and audits before and after", async () => {
    const id = await create();
    expect(await clients.setServices({ operator: alice, clientId: id, serviceSlugs: ["fault_repair", "ev_charger", "fault_repair"], requestId: rid() })).toEqual({ ok: true });
    expect((await clients.detail(id))!.services.map((service) => service.slug).sort()).toEqual(["ev_charger", "fault_repair"]);
    expect(await clients.setServices({ operator: alice, clientId: id, serviceSlugs: ["consumer_unit"], requestId: rid() })).toEqual({ ok: true });
    expect((await clients.detail(id))!.services.map((service) => service.slug)).toEqual(["consumer_unit"]);
    expect(await clients.setServices({ operator: alice, clientId: id, serviceSlugs: ["not_a_service"], requestId: rid() })).toEqual({ ok: false, code: "unknown_service" });
    const entry = (await auditFor(id)).at(-1)!;
    expect(entry.before).toEqual({ services: ["ev_charger", "fault_repair"] });
    expect(entry.after).toEqual({ services: ["consumer_unit"] });
  });

  it("will not empty the services of an active client", async () => {
    const id = await readyClient();
    await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() });
    expect(await clients.setServices({ operator: alice, clientId: id, serviceSlugs: [], requestId: rid() })).toEqual({ ok: false, code: "not_ready" });
    expect((await clients.detail(id))!.services).toHaveLength(1);
  });
});

describe("coverage rules", () => {
  it("adds every kind, words each plainly, and audits", async () => {
    const id = await create();
    const add = (rule: Parameters<ClientService["addRule"]>[0]["rule"]) => clients.addRule({ operator: alice, clientId: id, rule, requestId: rid() });
    for (const rule of [
      { mode: "include", kind: "outward", outward: "BR6" },
      { mode: "include", kind: "sector", sector: "BR5 1" },
      { mode: "exclude", kind: "postcode_prefix", postcodePrefix: "BR6 0A" },
      { mode: "include", kind: "area", serviceAreaSlug: "bromley" },
      { mode: "include", kind: "radius", centerPostcode: "TN13 1AA", radiusMetres: 16_093 },
    ] as const) {
      expect((await add(rule)).ok, JSON.stringify(rule)).toBe(true);
    }
    const labels = (await clients.detail(id))!.rules.map((rule) => `${rule.mode}: ${rule.label}`);
    // Includes first, then excludes; within each, by kind: district, sector, prefix, area, radius.
    expect(labels).toEqual([
      "include: Postcode district BR6",
      "include: Postcode sector BR5 1",
      "include: Area: Bromley",
      "include: Within 10 miles of TN13 1AA",
      'exclude: Postcodes starting "BR6 0A"',
    ]);
    expect((await auditFor(id)).filter((entry) => entry.action === "client.coverage_added")).toHaveLength(5);
  });

  it("refuses a duplicate rule, an unknown area and an unknown radius centre", async () => {
    const id = await create();
    const rule = { mode: "include", kind: "outward", outward: "BR6" } as const;
    expect((await clients.addRule({ operator: alice, clientId: id, rule, requestId: rid() })).ok).toBe(true);
    expect(await clients.addRule({ operator: alice, clientId: id, rule, requestId: rid() })).toEqual({ ok: false, code: "duplicate_rule" });
    expect(await clients.addRule({ operator: alice, clientId: id, rule: { mode: "include", kind: "area", serviceAreaSlug: "narnia" }, requestId: rid() })).toEqual({ ok: false, code: "unknown_area" });
    expect(await clients.addRule({ operator: alice, clientId: id, rule: { mode: "include", kind: "radius", centerPostcode: "ZZ99 9ZZ", radiusMetres: 5_000 }, requestId: rid() })).toEqual({ ok: false, code: "unknown_postcode" });
    expect((await clients.detail(id))!.rules).toHaveLength(1);
  });

  it("removes a rule, but only from the client that owns it", async () => {
    const [mine, theirs] = [await create({ name: "Mine" }), await create({ name: "Theirs" })];
    const added = await clients.addRule({ operator: alice, clientId: theirs, rule: { mode: "include", kind: "outward", outward: "DA1" }, requestId: rid() });
    if (!added.ok) throw new Error("setup");
    // Another client's rule id, presented under MY client id: not found, and nothing is deleted.
    expect(await clients.removeRule({ operator: alice, clientId: mine, ruleId: added.ruleId, requestId: rid() })).toEqual({ ok: false, code: "not_found" });
    expect((await clients.detail(theirs))!.rules).toHaveLength(1);
    expect(await clients.removeRule({ operator: alice, clientId: theirs, ruleId: added.ruleId, requestId: rid() })).toEqual({ ok: true });
    expect((await auditFor(theirs)).at(-1)).toMatchObject({ action: "client.coverage_removed", before: { mode: "include", rule: "Postcode district DA1" } });
  });

  it("will not remove the last include rule of an ACTIVE client, but will remove an exclude rule", async () => {
    const id = await readyClient();
    const exclude = await clients.addRule({ operator: alice, clientId: id, rule: { mode: "exclude", kind: "sector", sector: "BR6 0" }, requestId: rid() });
    await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() });
    const detail = (await clients.detail(id))!;
    const includeRule = detail.rules.find((rule) => rule.mode === "include")!;
    expect(await clients.removeRule({ operator: alice, clientId: id, ruleId: includeRule.id, requestId: rid() })).toEqual({ ok: false, code: "not_ready" });
    if (!exclude.ok) throw new Error("setup");
    expect(await clients.removeRule({ operator: alice, clientId: id, ruleId: exclude.ruleId, requestId: rid() })).toEqual({ ok: true });
  });
});

describe("races", () => {
  it("activating a client while its last include rule is removed can never leave an active client covering nowhere (20 trials)", async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const id = await readyClient(`Race ${trial}`);
      const rule = (await clients.detail(id))!.rules[0]!;
      await Promise.allSettled([
        clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() }),
        clients.removeRule({ operator: alice, clientId: id, ruleId: rule.id, requestId: rid() }),
      ]);
      const after = await t.admin.selectFrom("clients").select("status").where("id", "=", id).executeTakeFirstOrThrow();
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from client_service_areas where client_id = ${id} and mode = 'include' and active`.execute(t.admin);
      expect(after.status === "active" && rows[0]!.n === 0, `trial ${trial}: client is active with ${rows[0]!.n} include rules`).toBe(false);
    }
  });

  it("concurrent identical rule additions create exactly one rule and one audit entry", async () => {
    const id = await create();
    const rule = { mode: "include", kind: "outward", outward: "TN14" } as const;
    const results = await Promise.all(Array.from({ length: 8 }, () => clients.addRule({ operator: alice, clientId: id, rule, requestId: rid() })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "duplicate_rule")).toHaveLength(7);
    expect((await auditFor(id)).filter((entry) => entry.action === "client.coverage_added")).toHaveLength(1);
  });
});

describe("no pool deadlock: more concurrent operations than connections", () => {
  it("25 simultaneous creates, rule additions and status changes complete with a pool of 10", async () => {
    // A transaction that asks the pool for a SECOND connection while holding one deadlocks as soon as every connection is
    // held by such a transaction. 25 > 10 makes that certain if any operation does it.
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => clients.create({ operator: alice, client: input({ name: `Burst ${i}` }), requestId: rid() })));
    expect(new Set(results.map((result) => result.id)).size).toBe(25);
    const ruled = await Promise.all(results.map((result, i) => clients.addRule({ operator: alice, clientId: result.id, rule: { mode: "include", kind: "outward", outward: i % 2 ? "BR1" : "BR2" }, requestId: rid() })));
    expect(ruled.every((result) => result.ok)).toBe(true);
    const services = await Promise.all(results.map((result) => clients.setServices({ operator: alice, clientId: result.id, serviceSlugs: ["fault_repair"], requestId: rid() })));
    expect(services.every((result) => result.ok)).toBe(true);
    const status = await Promise.all(results.map((result) => clients.setStatus({ operator: alice, clientId: result.id, status: "active", requestId: rid() })));
    expect(status.every((result) => result.ok)).toBe(true);
  }, 30_000);
});

describe("every change is audited with the operator", () => {
  it("writes exactly one audit row per successful change and none for refused ones", async () => {
    const id = await create(); // 1
    const base = (await auditFor(id)).length;
    await clients.update({ operator: alice, clientId: id, client: input({ name: "Renamed" }), requestId: rid() }); // +1
    await clients.setServices({ operator: alice, clientId: id, serviceSlugs: ["fault_repair"], requestId: rid() }); // +1
    await clients.addRule({ operator: alice, clientId: id, rule: { mode: "include", kind: "outward", outward: "BR1" }, requestId: rid() }); // +1
    await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() }); // +1
    await clients.setStatus({ operator: alice, clientId: id, status: "active", requestId: rid() }); // refused: same status
    await clients.addRule({ operator: alice, clientId: id, rule: { mode: "include", kind: "outward", outward: "BR1" }, requestId: rid() }); // refused: duplicate
    const entries = await auditFor(id);
    expect(entries.length - base).toBe(4);
    expect(entries.every((entry) => entry.actor_id === alice.id && entry.actor_type === "staff_user" && entry.request_id)).toBe(true);
  });
});
