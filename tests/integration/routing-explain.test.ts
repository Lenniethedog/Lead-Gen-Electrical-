import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { buildRouting, type RoutingEnv } from "../helpers/routing";
import { insertRawLead } from "../helpers/raw";

/**
 * "Who would get this lead?" (the admin's dry run) must agree with what the router really does, because it is the same decision code
 * run read-only. Proved over a generated world rather than a hand-picked example, then checked for the things an explanation must
 * never do: write anything, or leave out why the router would not touch a lead.
 */
let env: RoutingEnv;
afterEach(async () => {
  await env?.destroy();
});

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POSTCODES = ["BR6 0AA", "BR5 1AA", "BR1 1AA", "TN13 1AA"];
const OUTWARD = ["BR6", "BR5", "BR1", "TN13"];

describe("the explanation agrees with the router", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`over a generated world (seed ${seed}): same choice, same ranking, same verdict for every business, and it writes nothing`, async () => {
      const random = prng(seed);
      const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
      env = await buildRouting();

      // Six businesses with different patches, preferences, hours, pauses.
      const clients: string[] = [];
      for (let n = 0; n < 6; n++) {
        const patch = OUTWARD.filter(() => random() < 0.6);
        const id = await env.s.activeClient(env.owner, { name: `Client ${n}`, outward: patch.length > 0 ? patch : ["BR6"] });
        clients.push(id);
        await env.prefs(id, { priority: [1, 10, 10, 50, 100][int(0, 4)]!, weight: [0, 1, 1, 2, 4][int(0, 4)]!, dailyCap: random() < 0.5 ? null : int(1, 5), monthlyCap: random() < 0.3 ? null : int(3, 12) });
        if (random() < 0.4) await env.hours(id, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "08:00", closes: `${int(12, 18)}:00` })));
        if (random() < 0.2) await env.pause(id, new Date("2026-10-04T00:00:00Z"), new Date("2026-10-07T00:00:00Z"));
      }
      await env.turnOn();

      for (let step = 0; step < 30; step++) {
        env.clock.at = new Date(Date.UTC(2026, 9, 5, int(7, 18), int(0, 59))); // a Monday, various times (BST)
        const lead = await insertRawLead(env.t.admin, { postcode: POSTCODES[int(0, POSTCODES.length - 1)]! });
        if (random() < 0.1) await env.t.admin.deleteFrom("pricing_rules").execute().catch(() => undefined); // (refused for the app role; harmless for the owner)

        const runsBefore = await env.t.admin.selectFrom("routing_runs").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
        const explained = await env.routing.explain(lead.id);
        const explainedAgain = await env.routing.explain(lead.id);
        const runsAfter = await env.t.admin.selectFrom("routing_runs").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
        expect(runsAfter, `step ${step}: explain must not write`).toEqual(runsBefore);
        expect(explainedAgain?.analysis, `step ${step}: explain is stable`).toEqual(explained?.analysis);
        expect(explained?.blockers, `step ${step}`).toEqual([]);

        const result = await env.routing.routeNext();
        expect(result?.leadId, `step ${step}`).toBe(lead.id);
        const [run] = await env.runsOf(lead.id);
        const stored = run!.candidates as { clients: Array<Record<string, unknown>>; notCovered: unknown[]; coverage: unknown; price: unknown };
        const analysis = explained!.analysis!;

        // Same facts, same verdicts: everything the real run stored about each candidate, minus what only the real run can know.
        const strip = (entry: Record<string, unknown>) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "result"));
        expect(analysis.detail.clients.map((entry) => strip(entry as unknown as Record<string, unknown>)), `step ${step}`).toEqual(stored.clients.map(strip));
        expect(analysis.detail.notCovered, `step ${step}`).toEqual(stored.notCovered);
        expect(analysis.detail.coverage, `step ${step}`).toEqual(stored.coverage);
        expect(analysis.detail.price, `step ${step}`).toEqual(stored.price);

        if (result!.outcome === "assigned") expect(analysis.chosenClientId, `step ${step}`).toBe(result!.clientId);
        else expect(analysis.ranking, `step ${step}`).toEqual([]);

        // A lead given to a business changes the next answer (fairness, caps): carry the assignment's time to the injected clock.
        if (result!.outcome === "assigned") await env.t.admin.updateTable("lead_assignments").set({ created_at: env.clock.at }).where("lead_id", "=", lead.id).execute();
      }
      // The world was not trivial: businesses were chosen, passed over and unroutable leads happened.
      const outcomes = await env.t.admin.selectFrom("routing_runs").select(["outcome"]).execute();
      expect(new Set(outcomes.map((row) => row.outcome)).has("assigned")).toBe(true);
    }, 60_000);
  }
});

describe("why the router would leave a lead alone", () => {
  it("says so, and still shows who would get it if it were routed", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner, { name: "Roofer" });
    const lead = await insertRawLead(env.t.admin);

    // Switched off.
    let explained = await env.routing.explain(lead.id);
    expect(explained).toMatchObject({ routingEnabled: false, blockers: ["routing_off"] });
    expect(explained?.analysis?.ranking).toHaveLength(1);

    // Switched on, but the lead arrived before it was.
    await env.turnOn();
    await env.t.admin.updateTable("routing_settings").set({ enabled_at: sql<Date>`now() + interval '1 minute'` }).execute();
    explained = await env.routing.explain(lead.id);
    expect(explained?.blockers).toEqual(["before_routing_was_enabled"]);
    await env.t.admin.updateTable("routing_settings").set({ enabled_at: sql<Date>`now() - interval '1 hour'` }).execute();
    await env.t.admin.updateTable("leads").set({ created_at: sql<Date>`now() - interval '30 minutes'` }).where("id", "=", lead.id).execute();
    expect((await env.routing.explain(lead.id))?.blockers).toEqual([]);

    // Too old, handled, taken back for a person, held, assigned, erased.
    await env.routing.setMaxLeadAge({ operator: env.owner, hours: 1, requestId: env.s.rid() });
    await env.t.admin.updateTable("routing_settings").set({ enabled_at: sql<Date>`now() - interval '5 hours'` }).execute();
    await env.t.admin.updateTable("leads").set({ created_at: sql<Date>`now() - interval '2 hours'` }).where("id", "=", lead.id).execute();
    expect((await env.routing.explain(lead.id))?.blockers).toEqual(["too_old"]);
    await env.t.admin.updateTable("leads").set({ created_at: sql<Date>`now()` }).where("id", "=", lead.id).execute();
    await env.t.admin.insertInto("lead_events").values({ lead_id: lead.id, type: "lead.handled", actor_type: "staff_user", actor_id: env.staff.id }).execute();
    expect((await env.routing.explain(lead.id))?.blockers).toEqual(["handled_by_a_person"]);
    await env.t.admin.insertInto("lead_events").values({ lead_id: lead.id, type: "lead.routing_stopped", actor_type: "staff_user", actor_id: env.staff.id }).execute();
    expect((await env.routing.explain(lead.id))?.blockers).toEqual(["handled_by_a_person", "routing_stopped"]);

    const held = await insertRawLead(env.t.admin, { status: "held", fraudDecision: "review" });
    expect((await env.routing.explain(held.id))?.blockers).toEqual(["not_routable_status"]);
    expect(await env.routing.explain("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("an unroutable lead is 'waiting to retry' until it is due, and the explanation shows the current answer meanwhile", async () => {
    env = await buildRouting();
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext(); // nobody: parked
    expect((await env.routing.explain(lead.id))?.blockers).toEqual(["waiting_to_retry"]);
    expect((await env.routing.explain(lead.id))?.analysis?.ranking).toEqual([]);
    await env.t.admin.updateTable("leads").set({ routing_attempted_at: sql<Date>`now() - interval '10 minutes'` }).where("id", "=", lead.id).execute();
    expect((await env.routing.explain(lead.id))?.blockers).toEqual([]);
  });

  it("an erased lead has no explanation of who would get it", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.s.privacy.erase({ operator: env.owner, leadId: lead.id, reason: "test_data", requestId: env.s.rid() });
    const explained = await env.routing.explain(lead.id);
    expect(explained?.analysis).toBeUndefined();
    expect(explained?.blockers).toContain("erased");
  });
});

describe("the overview", () => {
  it("reports settings, rules, how long routing takes, and what is waiting", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    for (let i = 0; i < 12; i++) await insertRawLead(env.t.admin);
    await env.routing.drain();
    await insertRawLead(env.t.admin, { postcode: "TN14 5AA" }); // nobody covers it
    await env.routing.drain();

    const overview = await env.routing.overview();
    expect(overview.settings).toMatchObject({ enabled: true, maxLeadAgeHours: 24 });
    expect(overview.rules.map((rule) => rule.type)).toEqual(["working_hours", "daily_cap", "monthly_cap", "priority", "weighted_fairness", "least_recently_assigned"]);
    expect(overview.rules.every((rule) => rule.title.length > 0 && rule.summary.length > 0)).toBe(true);
    expect(overview.stats).toMatchObject({ runs: 13, assigned: 12, noCandidates: 1, errors: 0, unroutableNow: 1 });
    expect(overview.stats.p95Ms).toBeGreaterThan(0);
    expect(overview.runs).toHaveLength(13);
    expect(overview.runs[0]!.createdAt.getTime()).toBeGreaterThanOrEqual(overview.runs[1]!.createdAt.getTime()); // newest first
  });

  it("routing takes well under the 100 ms target at the 95th percentile on one lead at a time (the load script measures it properly)", async () => {
    env = await buildRouting();
    for (let i = 0; i < 4; i++) await env.s.activeClient(env.owner, { name: `Client ${i}` });
    await env.turnOn();
    for (let i = 0; i < 60; i++) {
      await insertRawLead(env.t.admin);
      await env.routing.routeNext();
    }
    const stats = (await env.routing.overview()).stats;
    expect(stats.assigned).toBe(60);
    expect(stats.p95Ms!, `p95 ${stats.p95Ms} ms`).toBeLessThan(100);
  });
});
