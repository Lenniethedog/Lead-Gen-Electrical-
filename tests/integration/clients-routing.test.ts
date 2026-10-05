import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildStage3 } from "../helpers/stage3";

/**
 * What a business asked for about automatic leads (stage 4): priority, weight, caps, working hours and pauses. Every change is audited with who
 * and what, the database refuses nonsense on its own, and a pause typed in a business's local time means THAT time THERE.
 */
let t: TestDatabase;
let s: ReturnType<typeof buildStage3>;
let ops: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;

beforeAll(async () => {
  t = await createTestDatabase();
  s = buildStage3(t);
  ops = await s.operator("prefs@example.com");
});
afterAll(async () => {
  await t.destroy();
});

const audit = (clientId: string, action: string) => t.admin.selectFrom("audit_logs").selectAll().where("entity_id", "=", clientId).where("action", "=", action).orderBy("id").execute();

describe("priority, weight and caps", () => {
  it("start at the defaults (priority 100, weight 1, no caps, London time) and are read back", async () => {
    const id = await s.activeClient(ops);
    const result = await s.clients.routingPreferences(id);
    expect(result?.prefs).toEqual({ clientId: id, timezone: "Europe/London", priority: 100, weight: 1, dailyLeadCap: null, monthlyLeadCap: null });
    expect(result?.hours).toEqual([]);
    expect(result?.pauses).toEqual([]);
  });

  it("are saved with before and after in the audit trail", async () => {
    const id = await s.activeClient(ops);
    expect(await s.clients.setRoutingPreferences({ operator: ops, clientId: id, prefs: { priority: 10, weight: 3, dailyLeadCap: 5, monthlyLeadCap: 60 }, requestId: s.rid() })).toEqual({ ok: true });
    expect((await s.clients.routingPreferences(id))?.prefs).toMatchObject({ priority: 10, weight: 3, dailyLeadCap: 5, monthlyLeadCap: 60 });
    const [entry] = await audit(id, "client.routing_changed");
    expect(entry).toMatchObject({ actor_id: ops.id, before: { priority: 100, weight: 1, daily_lead_cap: null }, after: { priority: 10, weight: 3, daily_lead_cap: 5, monthly_lead_cap: 60 } });
  });

  it("an unknown client is not found, and the database refuses values the form should never send", async () => {
    expect(await s.clients.setRoutingPreferences({ operator: ops, clientId: "00000000-0000-4000-8000-000000000000", prefs: { priority: 1, weight: 1, dailyLeadCap: null, monthlyLeadCap: null }, requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await s.clients.routingPreferences("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    const id = await s.activeClient(ops);
    for (const bad of ["priority = 1001", "weight = 101", "daily_lead_cap = 0", "monthly_lead_cap = -1", "timezone = 'Not/AZone'"]) {
      await expect(sql.raw(`update clients set ${bad} where id = '${id}'`).execute(t.admin), bad).rejects.toThrow(/clients_.*_chk/);
    }
  });
});

describe("working hours", () => {
  it("replace the whole schedule, and an empty one means no restriction", async () => {
    const id = await s.activeClient(ops);
    const week = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "08:00", closes: "17:30" }));
    expect(await s.clients.setWorkingHours({ operator: ops, clientId: id, windows: week, requestId: s.rid() })).toEqual({ ok: true });
    expect((await s.clients.routingPreferences(id))?.hours).toEqual(week);

    const friday = [{ weekday: 5, opens: "09:00", closes: "12:00" }];
    await s.clients.setWorkingHours({ operator: ops, clientId: id, windows: friday, requestId: s.rid() });
    expect((await s.clients.routingPreferences(id))?.hours).toEqual(friday);

    await s.clients.setWorkingHours({ operator: ops, clientId: id, windows: [], requestId: s.rid() });
    expect((await s.clients.routingPreferences(id))?.hours).toEqual([]);

    const entries = await audit(id, "client.hours_changed");
    expect(entries.map((entry) => (entry.after as { windows: unknown[] }).windows.length)).toEqual([5, 1, 0]);
    expect((entries[1]!.before as { windows: unknown[] }).windows).toHaveLength(5);
  });

  it("the database refuses a window that closes before it opens, a bad weekday, and a duplicate opening time", async () => {
    const id = await s.activeClient(ops);
    await expect(sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${id}, 1, '17:00', '08:00')`.execute(t.admin)).rejects.toThrow(/check/i);
    await expect(sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${id}, 7, '08:00', '17:00')`.execute(t.admin)).rejects.toThrow(/check/i);
    await sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${id}, 1, '08:00', '12:00')`.execute(t.admin);
    await expect(sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${id}, 1, '08:00', '13:00')`.execute(t.admin)).rejects.toThrow(/duplicate|unique/i);
    // A lunch break is two windows in one day: allowed.
    await sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${id}, 1, '13:00', '17:00')`.execute(t.admin);
  });
});

describe("pauses", () => {
  it("a pause typed in the business's own local time means that time THERE (summer London, winter London, and Sydney)", async () => {
    const london = await s.activeClient(ops);
    const sydney = await s.activeClient(ops);
    await t.admin.updateTable("clients").set({ timezone: "Australia/Sydney" }).where("id", "=", sydney).execute();

    const add = (clientId: string, from: string, until: string) => s.clients.addPause({ operator: ops, clientId, pause: { from, until, reason: "holiday" }, requestId: s.rid() });
    expect(await add(london, "2026-10-12T09:00", "2026-10-19T09:00")).toMatchObject({ ok: true }); // BST: UTC+1
    expect(await add(london, "2026-12-14T09:00", "2026-12-21T09:00")).toMatchObject({ ok: true }); // GMT: UTC+0
    expect(await add(sydney, "2026-10-12T09:00", "2026-10-19T09:00")).toMatchObject({ ok: true }); // AEDT: UTC+11

    const times = async (clientId: string) => (await t.admin.selectFrom("client_pauses").select(["starts_at", "ends_at"]).where("client_id", "=", clientId).orderBy("starts_at").execute()).map((row) => [row.starts_at.toISOString(), row.ends_at.toISOString()]);
    expect(await times(london)).toEqual([["2026-10-12T08:00:00.000Z", "2026-10-19T08:00:00.000Z"], ["2026-12-14T09:00:00.000Z", "2026-12-21T09:00:00.000Z"]]);
    expect(await times(sydney)).toEqual([["2026-10-11T22:00:00.000Z", "2026-10-18T22:00:00.000Z"]]);
  });

  it("lists upcoming and active pauses, keeps recently ended ones visible, and removing one is audited", async () => {
    const id = await s.activeClient(ops);
    const day = 86_400_000;
    const insert = (startOffsetDays: number, endOffsetDays: number) => sql`insert into client_pauses (client_id, starts_at, ends_at, reason) values (${id}, ${new Date(Date.now() + startOffsetDays * day).toISOString()}, ${new Date(Date.now() + endOffsetDays * day).toISOString()}, 'other')`.execute(t.admin);
    await insert(-30, -20); // ended long ago: not listed
    await insert(-3, -1); // ended recently: listed
    await insert(-1, 2); // active
    await insert(5, 9); // upcoming
    const pauses = (await s.clients.routingPreferences(id))!.pauses;
    expect(pauses.map((pause) => pause.state)).toEqual(["upcoming", "active", "ended"]);

    const upcoming = pauses[0]!;
    expect(await s.clients.removePause({ operator: ops, clientId: id, pauseId: upcoming.id, requestId: s.rid() })).toEqual({ ok: true });
    expect((await s.clients.routingPreferences(id))!.pauses.map((pause) => pause.state)).toEqual(["active", "ended"]);
    expect(await s.clients.removePause({ operator: ops, clientId: id, pauseId: upcoming.id, requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
    const [removed] = await audit(id, "client.pause_removed");
    expect(removed).toMatchObject({ actor_id: ops.id, reason: "other", before: { pause_id: upcoming.id } });
  });

  it("cannot remove another business's pause, and refuses a pause that ends before it starts", async () => {
    const a = await s.activeClient(ops);
    const b = await s.activeClient(ops);
    const added = await s.clients.addPause({ operator: ops, clientId: a, pause: { from: "2026-10-12T09:00", until: "2026-10-13T09:00", reason: "holiday" }, requestId: s.rid() });
    if (!added.ok) throw new Error("setup");
    expect(await s.clients.removePause({ operator: ops, clientId: b, pauseId: added.pauseId, requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
    expect((await s.clients.routingPreferences(a))!.pauses).toHaveLength(1);
    await expect(sql`insert into client_pauses (client_id, starts_at, ends_at, reason) values (${a}, now(), now() - interval '1 hour', 'x')`.execute(t.admin)).rejects.toThrow(/check/i);
  });
});

describe("the application role", () => {
  it("can manage hours and pauses but never touch a routing run, and cannot delete a client", async () => {
    const id = await s.activeClient(ops);
    await sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${id}, 2, '08:00', '17:00')`.execute(t.db);
    await sql`delete from client_working_hours where client_id = ${id}`.execute(t.db);
    await expect(sql`delete from clients where id = ${id}`.execute(t.db)).rejects.toThrow(/permission denied/);
    await expect(sql`delete from routing_runs`.execute(t.db)).rejects.toThrow(/permission denied/);
    await expect(sql`update routing_rules set active = false`.execute(t.db)).resolves.toBeDefined(); // owners edit rules through the service
    await expect(sql`insert into routing_rules (vertical_id, type, kind, position) values (1, 'priority', 'ranker', 9)`.execute(t.db)).rejects.toThrow(/permission denied/);
  });
});
