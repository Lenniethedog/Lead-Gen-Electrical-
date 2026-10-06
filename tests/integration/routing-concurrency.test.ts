import { sql } from "kysely";
import { Client } from "pg";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Database } from "../../src/lib/db/client";
import { createInboxService } from "../../src/modules/inbox";
import { createRoutingService, type RoutingService } from "../../src/modules/routing";
import { insertRawLead } from "../helpers/raw";
import { buildRouting, type RoutingEnv } from "../helpers/routing";

/**
 * Many workers, few businesses (stage 4). The router claims a lead, decides and assigns in ONE transaction under ONE advisory lock, so
 * the guarantees are exact, not approximate: no lead is ever held twice, no business ever goes past its cap, equal businesses share
 * to within one lead, a crashed worker leaves the lead exactly as it was, and a person assigning by hand at the same moment never
 * produces a second assignment or an error.
 */
let env: RoutingEnv;
const extraPools: Database[] = [];
afterEach(async () => {
  await Promise.all(extraPools.splice(0).map((db) => db.destroy()));
  await env?.destroy();
});

/** A separate worker: its own connection pool, with the same guard rails as the real worker, so the lock waits are real. */
function worker(name: string): RoutingService {
  const db = createDb({ url: env.t.appUrl, poolMax: 3, applicationName: name, timeouts: { statementMs: 10_000, lockMs: 5_000, idleInTransactionMs: 15_000 } });
  extraPools.push(db);
  return createRoutingService({ db, logger: pino({ level: "silent" }), verticalSlug: "electrical", isSuppressed: env.s.privacy.isSuppressed });
}

const activeHeld = async (leadId?: string) => {
  const query = env.t.admin.selectFrom("lead_assignments").select(["lead_id", "client_id", "routing_run_id"]).where("status", "in", ["reserved", "notified", "accepted", "disputed"]);
  return (leadId ? query.where("lead_id", "=", leadId) : query).execute();
};

describe("many workers draining a burst", () => {
  it("assigns every lead exactly once, never passes a cap, and shares equal businesses to within one lead", async () => {
    env = await buildRouting();
    const capped = await env.s.activeClient(env.owner, { name: "Capped" });
    const b = await env.s.activeClient(env.owner, { name: "B" });
    const c = await env.s.activeClient(env.owner, { name: "C" });
    await env.prefs(capped, { priority: 1, dailyCap: 20 });
    await env.prefs(b, { priority: 50 });
    await env.prefs(c, { priority: 50 });
    await env.turnOn();

    const total = 90;
    const leads: string[] = [];
    for (let i = 0; i < total; i++) leads.push((await insertRawLead(env.t.admin)).id);

    const workers = Array.from({ length: 6 }, (_, n) => worker(`router-${n}`));
    const results = await Promise.all(workers.map((w) => w.drain({ max: 1000 })));
    expect(results.reduce((sum, r) => sum + r.assigned, 0)).toBe(total);
    expect(results.reduce((sum, r) => sum + r.errors, 0)).toBe(0);

    const held = await activeHeld();
    expect(held).toHaveLength(total);
    expect(new Set(held.map((row) => row.lead_id)).size).toBe(total); // never held twice
    expect(new Set(held.map((row) => row.routing_run_id)).size).toBe(total); // each explained by its own run
    const perClient = new Map<string, number>();
    for (const row of held) perClient.set(row.client_id, (perClient.get(row.client_id) ?? 0) + 1);
    expect(perClient.get(capped)).toBe(20); // exactly its cap: not 19, not 21
    expect(Math.abs(perClient.get(b)! - perClient.get(c)!)).toBeLessThanOrEqual(1); // 70 shared
    expect(perClient.get(b)! + perClient.get(c)!).toBe(70);

    const stuck = await env.t.admin.selectFrom("leads").select("status").where("id", "in", leads).execute();
    expect(new Set(stuck.map((row) => row.status))).toEqual(new Set(["assigned"]));
    expect(await env.t.admin.selectFrom("routing_runs").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).toEqual({ n: String(total) });
  }, 60_000);

  it("a burst nobody can take is parked once per lead, not retried by every worker", async () => {
    env = await buildRouting();
    await env.turnOn();
    const leads: string[] = [];
    for (let i = 0; i < 40; i++) leads.push((await insertRawLead(env.t.admin)).id);
    const workers = Array.from({ length: 6 }, (_, n) => worker(`router-${n}`));
    const results = await Promise.all(workers.map((w) => w.drain({ max: 1000 })));
    expect(results.reduce((sum, r) => sum + r.unroutable, 0)).toBe(40);
    const runs = await env.t.admin.selectFrom("routing_runs").select(["lead_id"]).execute();
    expect(runs).toHaveLength(40);
    expect(new Set(runs.map((run) => run.lead_id)).size).toBe(40);
    const events = await env.t.admin.selectFrom("lead_events").select("lead_id").where("type", "=", "lead.unroutable").execute();
    expect(events).toHaveLength(40);
  }, 60_000);

  it("workers started while leads keep arriving still never double-assign", async () => {
    env = await buildRouting();
    for (let i = 0; i < 3; i++) await env.s.activeClient(env.owner, { name: `Client ${i}` });
    await env.turnOn();
    const workers = Array.from({ length: 4 }, (_, n) => worker(`router-${n}`));
    let stop = false;
    const producer = (async () => {
      for (let i = 0; i < 60; i++) {
        await insertRawLead(env.t.admin);
        if (i % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      stop = true;
    })();
    const consumers = workers.map(async (w) => {
      while (!stop) {
        await w.drain({ max: 10 });
        await new Promise((resolve) => setTimeout(resolve, 3));
      }
    });
    await Promise.all([producer, ...consumers]);
    await Promise.all(workers.map((w) => w.drain({ max: 1000 })));

    const held = await activeHeld();
    expect(held).toHaveLength(60);
    expect(new Set(held.map((row) => row.lead_id)).size).toBe(60);
  }, 60_000);
});

describe("a worker that dies", () => {
  it("leaves the lead exactly as it was: still new, no run, no assignment, nothing to recover", async () => {
    env = await buildRouting();
    const client = await env.s.activeClient(env.owner, { name: "Only" });
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);

    // Hold the business's row so the router blocks half way through its transaction (after it has claimed the lead).
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const blocker = env.t.admin.transaction().execute(async (trx) => {
      await sql`select 1 from clients where id = ${client} for update`.execute(trx);
      held();
      await gate;
    });
    await holding;

    const doomed = worker("router-doomed");
    const attempt = doomed.routeNext().then(() => "finished", (error: unknown) => `died: ${(error as { message?: string }).message ?? error}`);

    // Wait until it really is blocked, then kill its connection (what a crash, a failover or an OOM kill looks like to the database).
    let pid: number | undefined;
    for (let i = 0; i < 200 && pid === undefined; i++) {
      const { rows } = await sql<{ pid: number }>`select pid from pg_stat_activity where application_name = 'router-doomed' and wait_event_type = 'Lock'`.execute(env.t.admin);
      pid = rows[0]?.pid;
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(pid, "the router should be blocked on the business's row").toBeDefined();
    await sql`select pg_terminate_backend(${pid})`.execute(env.t.admin);
    expect(await attempt).toMatch(/^died:/);

    release();
    await blocker;
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "new", routing_attempted_at: null });
    expect(await env.runsOf(lead.id)).toHaveLength(0);
    expect(await env.assignmentsOf(lead.id)).toHaveLength(0);

    // A healthy worker picks it up straight away: nothing was parked, nothing has to expire.
    expect(await worker("router-healthy").routeNext()).toMatchObject({ outcome: "assigned", clientId: client });
  }, 30_000);

  it("a lead whose routing hits a lock timeout is retried, not parked", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);

    // Hold the routing lock longer than the worker is willing to wait (lock_timeout 1 s here).
    const impatient = createDb({ url: env.t.appUrl, poolMax: 2, applicationName: "router-impatient", timeouts: { statementMs: 10_000, lockMs: 1_000, idleInTransactionMs: 15_000 } });
    extraPools.push(impatient);
    const router = createRoutingService({ db: impatient, logger: pino({ level: "silent" }), verticalSlug: "electrical", isSuppressed: env.s.privacy.isSuppressed });

    const vertical = await env.t.admin.selectFrom("verticals").select("id").executeTakeFirstOrThrow();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const blocker = env.t.admin.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext('leadgen.routing'), ${vertical.id})`.execute(trx);
      held();
      await gate;
    });
    await holding;
    await expect(router.routeNext()).rejects.toThrow(/lock timeout/i);
    release();
    await blocker;
    // Not parked: it is still new, and the next attempt succeeds.
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "new" });
    expect(await router.routeNext()).toMatchObject({ outcome: "assigned" });
  }, 30_000);
});

describe("something changes while the router is deciding", () => {
  /**
   * The router reads its facts, ranks, and only THEN locks the business it wants. A person can pause the business, or remove its coverage,
   * in that gap. Here the test holds the first choice's row so the router is stuck at exactly that point, changes the business, and lets go.
   */
  async function changedWhileDeciding<T = undefined>(change: (trx: Database, clientId: string, extra: T) => Promise<void>, prepare?: () => Promise<T>) {
    env = await buildRouting();
    const first = await env.s.activeClient(env.owner, { name: "First" });
    const second = await env.s.activeClient(env.owner, { name: "Second" });
    await env.prefs(first, { priority: 1 });
    await env.prefs(second, { priority: 50 });
    const extra = (await prepare?.()) as T; // arranged BEFORE routing is switched on, so the router never sees it as a lead to route
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const blocker = env.t.admin.transaction().execute(async (trx) => {
      await sql`select 1 from clients where id = ${first} for update`.execute(trx);
      held();
      await gate;
      await change(trx, first, extra);
    });
    await holding;

    const routed = worker("router-gap").routeNext();
    let blocked = false;
    for (let i = 0; i < 200 && !blocked; i++) {
      const { rows } = await sql<{ n: string }>`select count(*) n from pg_stat_activity where application_name = 'router-gap' and wait_event_type = 'Lock'`.execute(env.t.admin);
      blocked = Number(rows[0]!.n) > 0;
      if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(blocked, "the router should be waiting for the first business's row").toBe(true);
    release();
    await blocker;
    const result = await routed;
    return { first, second, lead, result };
  }

  it("a business paused in that gap is passed over, and the run says so", async () => {
    const { first, second, lead, result } = await changedWhileDeciding(async (trx, clientId) => {
      await sql`update clients set status = 'paused' where id = ${clientId}`.execute(trx);
    });
    expect(result).toMatchObject({ outcome: "assigned", clientId: second });
    expect(await env.assignmentsOf(lead.id)).toHaveLength(1);
    const detail = (await env.runsOf(lead.id))[0]!.candidates as { clients: Array<{ clientId: string; result?: string }> };
    expect(detail.clients.find((client) => client.clientId === first)?.result).toBe("changed_while_routing");
    expect(detail.clients.find((client) => client.clientId === second)?.result).toBe("chosen");
  }, 30_000);

  it("a business that loses its coverage in that gap is passed over", async () => {
    const { second, lead, result } = await changedWhileDeciding(async (trx, clientId) => {
      await sql`delete from client_service_areas where client_id = ${clientId}`.execute(trx);
    });
    expect(result).toMatchObject({ outcome: "assigned", clientId: second });
    expect(await env.assignmentsOf(lead.id)).toHaveLength(1);
  }, 30_000);

  it("a business that reaches its cap in that gap (someone assigned it a lead by hand) is passed over", async () => {
    const { second, lead, result } = await changedWhileDeciding(
      async (trx, clientId, otherLeadId: string) => {
        await sql`update clients set daily_lead_cap = 1 where id = ${clientId}`.execute(trx);
        await sql`update leads set sale_model = 'exclusive' where id = ${otherLeadId}`.execute(trx);
        const { rows } = await sql<{ id: string }>`insert into routing_runs (lead_id, outcome, rules, algorithm_version, chosen_client_id) values (${otherLeadId}, 'assigned', '[]', 't', ${clientId}) returning id`.execute(trx);
        await sql`insert into lead_assignments (lead_id, client_id, sale_type, assigned_by, routing_run_id, price_pence) values (${otherLeadId}, ${clientId}, 'exclusive', 'router', ${rows[0]!.id}, 3500)`.execute(trx);
        await sql`update leads set status = 'assigned' where id = ${otherLeadId}`.execute(trx);
      },
      async () => (await insertRawLead(env.t.admin)).id,
    );
    expect(result).toMatchObject({ outcome: "assigned", clientId: second });
    expect(await env.assignmentsOf(lead.id)).toHaveLength(1);
  }, 30_000);
});

describe("a person at the same time", () => {
  it("assigning by hand while the router runs never produces two holders and never throws", async () => {
    env = await buildRouting();
    const a = await env.s.activeClient(env.owner, { name: "A" });
    const b = await env.s.activeClient(env.owner, { name: "B" });
    await env.turnOn();
    const leads: string[] = [];
    for (let i = 0; i < 40; i++) leads.push((await insertRawLead(env.t.admin)).id);

    const workers = [worker("router-1"), worker("router-2")];
    const manual = (async () => {
      const outcomes: Array<{ ok: boolean; code?: string }> = [];
      for (const leadId of leads) outcomes.push(await env.s.assignments.assign({ operator: env.staff, leadId, clientId: leadId.charCodeAt(0) % 2 === 0 ? a : b, requestId: env.s.rid() }));
      return outcomes;
    })();
    const [outcomes] = await Promise.all([manual, ...workers.map((w) => w.drain({ max: 1000 }))]);

    for (const outcome of outcomes) expect(outcome.ok || ["already_assigned", "lead_not_assignable"].includes(outcome.code!), JSON.stringify(outcome)).toBe(true);
    const held = await activeHeld();
    expect(held).toHaveLength(40);
    expect(new Set(held.map((row) => row.lead_id)).size).toBe(40);
    // Both kinds happened (the race was real), and every automatic one is explained while no manual one is.
    const byRouter = await env.t.admin.selectFrom("lead_assignments").select(["assigned_by", "routing_run_id", "assigned_by_user_id"]).execute();
    expect(byRouter.every((row) => (row.assigned_by === "router") === (row.routing_run_id !== null))).toBe(true);
    expect(byRouter.every((row) => (row.assigned_by === "staff") === (row.assigned_by_user_id !== null))).toBe(true);
  }, 60_000);

  it("a consumer withdrawing consent while the router runs never leaves a withdrawn lead held by anyone", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner, { name: "A" });
    await env.s.activeClient(env.owner, { name: "B" });
    await env.turnOn();
    const leads: string[] = [];
    for (let i = 0; i < 24; i++) leads.push((await insertRawLead(env.t.admin, { email: `person${i}@example.com`, phone: `+4479111${String(10000 + i)}` })).id);

    const workers = [worker("router-1"), worker("router-2")];
    const withdrawals = Promise.all(leads.filter((_, i) => i % 2 === 0).map((leadId) => env.s.privacy.withdrawConsent({ operator: env.staff, leadId, requestId: env.s.rid() })));
    await Promise.all([withdrawals, ...workers.map((w) => w.drain({ max: 1000 }))]);
    await Promise.all(workers.map((w) => w.drain({ max: 1000 })));

    for (const [i, leadId] of leads.entries()) {
      const row = await env.leadRow(leadId);
      const held = await activeHeld(leadId);
      if (i % 2 === 0) {
        expect(row.status, `lead ${i}`).toBe("invalid");
        expect(held, `lead ${i}`).toHaveLength(0);
      } else {
        expect(row.status, `lead ${i}`).toBe("assigned");
        expect(held, `lead ${i}`).toHaveLength(1);
      }
    }
  }, 60_000);

  it("a lead the consumer has since asked us to stop contacting is never routed (suppression is checked at the last moment)", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const first = await insertRawLead(env.t.admin, { email: "stop.me@example.com", phone: "+447911222333" });
    await env.s.privacy.withdrawConsent({ operator: env.staff, leadId: first.id, requestId: env.s.rid() }); // suppresses the identity
    // The same person enquires again: fresh consent, so it counts as a new relationship and IS routed.
    const again = await insertRawLead(env.t.admin, { email: "stop.me@example.com", phone: "+447911222333" });
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: again.id });

    // But if they ask us to stop AFTER that enquiry and before it is routed, the router refuses and closes the lead.
    const third = await insertRawLead(env.t.admin, { email: "stop.me@example.com", phone: "+447911222333" });
    await env.s.privacy.withdrawConsent({ operator: env.staff, leadId: (await insertRawLead(env.t.admin, { email: "stop.me@example.com", phone: "+447911222333", status: "held", fraudDecision: "review" })).id, requestId: env.s.rid() });
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "skipped", reason: "suppressed", leadId: third.id });
    expect(await env.leadRow(third.id)).toMatchObject({ status: "invalid" });
    expect(await env.assignmentsOf(third.id)).toHaveLength(0);
  });
});

describe("waking the router", () => {
  it("a lead arriving, a lead becoming new again, and a change to a client, price, coverage, rule, pause or hours each send a notification", async () => {
    env = await buildRouting();
    const client = await env.s.activeClient(env.owner);
    const listener = new Client({ connectionString: env.t.ownerUrl });
    await listener.connect();
    await listener.query("listen routing_due");
    let received = 0;
    listener.on("notification", () => (received += 1));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const expectWake = async (label: string, action: () => Promise<unknown>) => {
      const before = received;
      await action();
      await settle();
      expect(received, label).toBeGreaterThan(before);
    };
    try {
      await settle();
      await expectWake("a new lead", () => insertRawLead(env.t.admin));
      const held = await insertRawLead(env.t.admin, { status: "held", fraudDecision: "review" });
      const inbox = createInboxService({ db: env.t.db, logger: pino({ level: "silent" }) });
      await expectWake("a held lead approved", () => inbox.approve({ operator: env.staff, leadId: held.id, reason: "genuine", requestId: env.s.rid() }));
      await expectWake("a client edited", () => env.s.clients.update({ operator: env.owner, clientId: client, client: { name: "Renamed", contactEmail: "r@electrician.example", contactPhone: undefined, contactName: undefined, legalName: undefined, companyNumber: undefined, acceptsExclusive: true, acceptsShared: false, notes: undefined }, requestId: env.s.rid() }));
      await expectWake("a price set", () => env.s.setPrice(env.owner, 4000));
      await expectWake("a coverage rule added", () => env.s.clients.addRule({ operator: env.owner, clientId: client, rule: { mode: "include", kind: "outward", outward: "BR5" }, requestId: env.s.rid() }));
      await expectWake("working hours changed", () => env.hours(client, [{ weekday: 1, opens: "09:00", closes: "17:00" }]));
      await expectWake("a pause added", () => env.pause(client, new Date(Date.now() + 86_400_000), new Date(Date.now() + 2 * 86_400_000)));
      const rule = (await env.routing.overview()).rules[0]!;
      await expectWake("a rule edited", () => env.routing.updateRule({ operator: env.owner, ruleId: rule.id, expectedVersion: rule.version, active: true, config: rule.config, requestId: env.s.rid() }));

      // And an unrelated change does NOT wake it.
      const quiet = received;
      await sql`update lead_contacts set full_name = 'x' where lead_id = ${held.id}`.execute(env.t.admin);
      await settle();
      expect(received).toBe(quiet);
    } finally {
      await listener.end();
    }
  });

  it("a change makes a lead that found nobody due again immediately; nothing else does", async () => {
    env = await buildRouting();
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect(await env.routing.routeNext()).toBeUndefined();
    await env.s.activeClient(env.owner);
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: lead.id });
  });
});
