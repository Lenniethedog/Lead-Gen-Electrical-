import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { buildRouting, type RoutingEnv } from "../helpers/routing";
import { insertRawAssignment, insertRawLead } from "../helpers/raw";

/**
 * Automatic routing (stage 4), against a real database. What must hold: nothing is routed unless an owner switched routing on and the
 * lead arrived while it was on; the right business gets the lead and the reason is recorded; caps, hours, pauses and "gave it back"
 * are honoured; a lead nobody can take is never lost or retried in a hot loop; and every decision can be explained afterwards.
 */
let env: RoutingEnv;
afterEach(async () => {
  await env?.destroy();
});

const BR6 = "BR6 0AA";

describe("the switch", () => {
  it("is OFF until an owner turns it on: nothing is routed, nothing is recorded", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    const lead = await insertRawLead(env.t.admin);
    expect(await env.routing.routeNext()).toBeUndefined();
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "new" });
    expect(await env.runsOf(lead.id)).toHaveLength(0);
  });

  it("can only be switched by an owner, and the change is audited", async () => {
    env = await buildRouting();
    expect(await env.routing.setEnabled({ operator: env.staff, enabled: true, requestId: env.s.rid() })).toEqual({ ok: false, code: "forbidden" });
    await env.turnOn();
    await env.routing.setEnabled({ operator: env.owner, enabled: false, requestId: env.s.rid() });
    const audit = await env.t.admin.selectFrom("audit_logs").select(["action", "actor_id", "before", "after"]).where("entity_type", "=", "routing").orderBy("id").execute();
    expect(audit.map((entry) => entry.action)).toEqual(["routing.enabled", "routing.disabled"]);
    expect(audit[0]).toMatchObject({ actor_id: env.owner.id, before: { enabled: false }, after: { enabled: true } });
  });

  it("only ever routes leads that ARRIVED while routing was on", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    const before = await insertRawLead(env.t.admin);
    await env.turnOn();
    const after = await insertRawLead(env.t.admin);
    const result = await env.routing.routeNext();
    expect(result).toMatchObject({ outcome: "assigned", leadId: after.id });
    expect(await env.routing.routeNext()).toBeUndefined();
    expect(await env.leadRow(before.id)).toMatchObject({ status: "new" }); // left for a person: it is in "Needs action"
  });

  it("switching it on again does not move the start time (which would silently strand waiting leads)", async () => {
    env = await buildRouting();
    await env.turnOn();
    const first = await env.t.admin.selectFrom("routing_settings").select("enabled_at").executeTakeFirstOrThrow();
    await env.turnOn();
    const second = await env.t.admin.selectFrom("routing_settings").select("enabled_at").executeTakeFirstOrThrow();
    expect(second.enabled_at).toEqual(first.enabled_at);
  });

  it("does not route a lead older than the age limit, test leads, handled leads, held leads or leads a person took back", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    await env.routing.setMaxLeadAge({ operator: env.owner, hours: 1, requestId: env.s.rid() });

    const old = await insertRawLead(env.t.admin);
    await env.t.admin.updateTable("leads").set({ created_at: sql<Date>`now() - interval '2 hours'` }).where("id", "=", old.id).execute();
    await env.t.admin.updateTable("routing_settings").set({ enabled_at: sql<Date>`now() - interval '3 hours'` }).execute();
    const test = await insertRawLead(env.t.admin, { isTest: true });
    const handled = await insertRawLead(env.t.admin);
    await env.t.admin.insertInto("lead_events").values({ lead_id: handled.id, type: "lead.handled", actor_type: "staff_user", actor_id: env.staff.id }).execute();
    const stopped = await insertRawLead(env.t.admin);
    await env.t.admin.insertInto("lead_events").values({ lead_id: stopped.id, type: "lead.routing_stopped", actor_type: "staff_user", actor_id: env.staff.id }).execute();
    const held = await insertRawLead(env.t.admin, { status: "held", fraudDecision: "review" });

    expect(await env.routing.routeNext()).toBeUndefined();
    for (const lead of [old, test, handled, stopped, held]) expect(await env.runsOf(lead.id)).toHaveLength(0);
  });
});

describe("handing the lead over", () => {
  it("assigns the only eligible business at the price from the pricing rules, and records who and why", async () => {
    env = await buildRouting({ price: 4200 });
    const client = await env.s.activeClient(env.owner, { name: "Only Roofing" });
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);

    const result = await env.routing.routeNext();
    expect(result).toMatchObject({ outcome: "assigned", clientId: client, leadId: lead.id });
    expect(result?.durationMs).toBeGreaterThan(0);

    expect(await env.leadRow(lead.id)).toMatchObject({ status: "assigned", sale_model: "exclusive", assignments_count: 1 });
    const [assignment] = await env.assignmentsOf(lead.id);
    expect(assignment).toMatchObject({ client_id: client, status: "reserved", assigned_by: "router", assigned_by_user_id: null, price_pence: 4200, sale_type: "exclusive" });
    expect(assignment!.pricing_rule_id).toBeTruthy();

    // The run explains it and is linked to the assignment.
    const [run] = await env.runsOf(lead.id);
    expect(run).toMatchObject({ outcome: "assigned", chosen_client_id: client, price_pence: 4200, algorithm_version: "1", error: null });
    expect(assignment!.routing_run_id).toBe(run!.id);
    expect(run!.duration_ms).toBeGreaterThanOrEqual(0);

    // History names the SYSTEM and the reason, for the lead and for the assignment.
    const history = await env.t.admin.selectFrom("lead_assignment_status_history").selectAll().where("assignment_id", "=", assignment!.id).execute();
    expect(history[0]).toMatchObject({ from_status: null, to_status: "reserved", actor_type: "system", actor_id: null, reason: "auto_routed" });
    const leadHistory = await env.t.admin.selectFrom("lead_status_history").selectAll().where("lead_id", "=", lead.id).orderBy("id").execute();
    expect(leadHistory.at(-1)).toMatchObject({ from_status: "new", to_status: "assigned", actor_type: "system", reason: "auto_routed" });
    // The timeline entry carries ids only.
    const routed = (await env.eventsOf(lead.id)).find((event) => event.type === "lead.routed");
    expect(routed).toMatchObject({ actor_type: "system", payload: { run_id: run!.id, client_id: client } });
  });

  it("records every candidate with its verdict and rank, the businesses that do not cover the lead and why, and the rules in force", async () => {
    env = await buildRouting();
    const first = await env.s.activeClient(env.owner, { name: "First" });
    const second = await env.s.activeClient(env.owner, { name: "Second" });
    await env.s.activeClient(env.owner, { name: "Elsewhere", outward: ["TN13"] });
    await env.prefs(first, { priority: 10 });
    await env.prefs(second, { priority: 20 });
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext();

    const [run] = await env.runsOf(lead.id);
    const detail = run!.candidates as { clients: Array<{ clientId: string; eligible: boolean; rank: number | null; result?: string; keys: unknown }>; notCovered: Array<{ name: string; reasons: string[] }>; coverage: { clients: number; covered: number }; price: { pence: number } };
    expect(detail.coverage).toEqual({ clients: 3, covered: 2 });
    const byId = new Map(detail.clients.map((entry) => [entry.clientId, entry]));
    expect(byId.get(first)).toMatchObject({ rank: 1, result: "chosen", eligible: true });
    expect(byId.get(second)).toMatchObject({ rank: 2, eligible: true });
    expect(byId.get(second)?.result).toBeUndefined();
    expect(detail.notCovered).toEqual([{ clientId: expect.any(String), name: "Elsewhere", reasons: ["no_include_rule_matches"] }]);
    expect(detail.price.pence).toBe(3500);
    expect((run!.rules as Array<{ type: string }>).map((rule) => rule.type)).toEqual(["working_hours", "daily_cap", "monthly_cap", "priority", "weighted_fairness", "least_recently_assigned"]);
  });

  it("holds no personal data in a run, an event or the history: a distinctive contact never appears", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin, { email: "distinctive.person@example.org", phone: "+447911555123" });
    await env.t.admin.updateTable("lead_contacts").set({ full_name: "Distinctive Personname" }).where("lead_id", "=", lead.id).execute();
    await env.routing.routeNext();

    const dump = JSON.stringify([
      await env.runsOf(lead.id), await env.eventsOf(lead.id),
      await env.t.admin.selectFrom("lead_status_history").selectAll().where("lead_id", "=", lead.id).execute(),
      await env.t.admin.selectFrom("lead_assignment_status_history").selectAll().execute(),
    ]);
    for (const secret of ["distinctive.person", "Distinctive", "447911555123", "07911555123", "BR6 0AA"]) expect(dump).not.toContain(secret);
  });

  it("gives the lead to a business once and never again after it was given back, even if it is the only one left", async () => {
    env = await buildRouting();
    const a = await env.s.activeClient(env.owner, { name: "A" });
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    const [assignment] = await env.assignmentsOf(lead.id);

    // A person takes it back because the business declined: a reason that SHOULD re-route to someone else.
    expect(await env.s.assignments.cancel({ operator: env.staff, assignmentId: assignment!.id, reason: "client_declined", requestId: env.s.rid() })).toEqual({ ok: true });
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "new" });

    // Nobody else covers it: A already had it and gave it back, so it is NOT offered again.
    const second = await env.routing.routeNext();
    expect(second).toMatchObject({ outcome: "no_candidates", reason: "no_eligible_client" });
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "unroutable" });
    const [, secondRun] = await env.runsOf(lead.id);
    const detail = secondRun!.candidates as { clients: Array<{ clientId: string; excludedBy: string[] }> };
    expect(detail.clients).toEqual([expect.objectContaining({ clientId: a, excludedBy: ["previously_held"] })]);

    // A new business appears: the lead is picked up promptly (the client change pokes the router; no five-minute wait).
    const b = await env.s.activeClient(env.owner, { name: "B" });
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "assigned", clientId: b });
  });

  it("a take-back for a reason that needs a PERSON is not re-routed by the router", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner, { name: "A" });
    await env.s.activeClient(env.owner, { name: "B" });
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    const [assignment] = await env.assignmentsOf(lead.id);
    await env.s.assignments.cancel({ operator: env.staff, assignmentId: assignment!.id, reason: "quality_issue", requestId: env.s.rid() });

    expect(await env.leadRow(lead.id)).toMatchObject({ status: "new" });
    expect(await env.routing.routeNext()).toBeUndefined();
    expect((await env.eventsOf(lead.id)).map((event) => event.type)).toContain("lead.routing_stopped");
  });

  it("an operator can still hand an unroutable lead to a business by hand", async () => {
    env = await buildRouting();
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "no_candidates" }); // nobody exists
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "unroutable" });

    const roofer = await env.s.activeClient(env.owner, { name: "Late Roofer", outward: ["TN13"] });
    const result = await env.s.assignments.assign({ operator: env.staff, leadId: lead.id, clientId: roofer, coverageException: true, requestId: env.s.rid() });
    expect(result).toMatchObject({ ok: true, outsideCoverage: true });
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "assigned" });
  });
});

describe("consent", () => {
  it("never routes a lead whose consent does not allow passing it to a business, and parks it for a person", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const firstParty = await env.t.admin
      .insertInto("consent_texts")
      .values({ code: "first_party_only", version: "v901", body: "We will contact you ourselves, not a business.", body_sha256: "b".repeat(64), recipient_model: "first_party", max_recipients: 0, channels: ["phone"] })
      .returning("id")
      .executeTakeFirstOrThrow();
    const lead = await insertRawLead(env.t.admin, { consentTextId: firstParty.id });

    expect(await env.routing.routeNext()).toMatchObject({ outcome: "skipped", reason: "no_consent_to_share" });
    expect(await env.assignmentsOf(lead.id)).toHaveLength(0);
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "unroutable" });
    expect((await env.runsOf(lead.id))[0]).toMatchObject({ outcome: "skipped", error: "no_consent_to_share", chosen_client_id: null });
  });
});

describe("a lead nobody can take", () => {
  it("is parked as unroutable with a run that says why, announced once, and not retried in a hot loop", async () => {
    env = await buildRouting();
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);

    expect(await env.routing.routeNext()).toMatchObject({ outcome: "no_candidates", reason: "no_eligible_client" });
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "unroutable" });
    expect(await env.routing.routeNext()).toBeUndefined(); // not due again: no spinning
    expect(await env.routing.routeNext()).toBeUndefined();
    const runs = await env.runsOf(lead.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ outcome: "no_candidates", error: "no_eligible_client", chosen_client_id: null });
    expect((await env.eventsOf(lead.id)).filter((event) => event.type === "lead.unroutable")).toHaveLength(1);
    const history = await env.t.admin.selectFrom("lead_status_history").selectAll().where("lead_id", "=", lead.id).orderBy("id").execute();
    expect(history.at(-1)).toMatchObject({ from_status: "new", to_status: "unroutable", actor_type: "system", reason: "routing_no_candidates" });
  });

  it("is looked at again after the retry interval even if nothing changed, without repeating the announcement", async () => {
    env = await buildRouting();
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect(await env.routing.routeNext()).toBeUndefined();

    await env.t.admin.updateTable("leads").set({ routing_attempted_at: sql<Date>`now() - interval '6 minutes'` }).where("id", "=", lead.id).execute();
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "no_candidates" });
    expect(await env.runsOf(lead.id)).toHaveLength(2);
    expect((await env.eventsOf(lead.id)).filter((event) => event.type === "lead.unroutable")).toHaveLength(1);
    // A retry that fails again is itself an attempt: the lead is not due again until ANOTHER interval passes (no hot loop on retries).
    expect(await env.routing.routeNext()).toBeUndefined();
    expect(await env.routing.routeNext()).toBeUndefined();
    expect(await env.runsOf(lead.id)).toHaveLength(2);
  });

  it("is picked up the moment a business is activated, covers it, or a price is set (no waiting)", async () => {
    env = await buildRouting({ price: null });
    const client = await env.s.activeClient(env.owner, { name: "Priceless" });
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);

    // No pricing rule: the router never invents a price.
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "no_candidates", reason: "price_required" });
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "unroutable" });
    expect(await env.routing.routeNext()).toBeUndefined();

    await env.s.setPrice(env.owner, 3900);
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "assigned", clientId: client });
    expect((await env.assignmentsOf(lead.id))[0]).toMatchObject({ price_pence: 3900 });
  });

  it("is parked, not retried in a hot loop, when something unexpected goes wrong with it, and the failure is recorded", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    // A stored rule configuration that no longer validates: the router must fail CLOSED, not route on rules nobody understands.
    await env.t.admin.updateTable("routing_rules").set({ config: JSON.stringify({ graceMinutes: 9999 }) }).where("type", "=", "working_hours").execute();

    expect(await env.routing.routeNext()).toMatchObject({ outcome: "error", reason: "exception" });
    expect(await env.leadRow(lead.id)).toMatchObject({ status: "unroutable" });
    expect(await env.assignmentsOf(lead.id)).toHaveLength(0);
    expect((await env.runsOf(lead.id))[0]).toMatchObject({ outcome: "error", error: "rules_invalid" });
    expect(await env.routing.routeNext()).toBeUndefined();
    expect((await env.eventsOf(lead.id)).map((event) => event.type)).toContain("lead.unroutable");
  });
});

describe("who gets it", () => {
  const route = async (n: number, postcode = BR6) => {
    const results = [];
    for (let i = 0; i < n; i++) {
      const lead = await insertRawLead(env.t.admin, { postcode });
      const result = await env.routing.routeNext();
      results.push({ lead: lead.id, client: result?.clientId, outcome: result?.outcome });
    }
    return results;
  };

  it("the lowest priority number goes first", async () => {
    env = await buildRouting();
    const low = await env.s.activeClient(env.owner, { name: "Low" });
    const high = await env.s.activeClient(env.owner, { name: "High" });
    await env.prefs(low, { priority: 200 });
    await env.prefs(high, { priority: 5 });
    await env.turnOn();
    expect((await route(3)).map((result) => result.client)).toEqual([high, high, high]);
  });

  it("equal businesses share fairly, in proportion to their weight", async () => {
    env = await buildRouting();
    const a = await env.s.activeClient(env.owner, { name: "A" });
    const b = await env.s.activeClient(env.owner, { name: "B" });
    const c = await env.s.activeClient(env.owner, { name: "C" });
    await env.prefs(a, { weight: 1 });
    await env.prefs(b, { weight: 2 });
    await env.prefs(c, { weight: 3 });
    await env.turnOn();
    await route(36);
    const held = await env.holdings();
    expect([held.get(a), held.get(b), held.get(c)]).toEqual([6, 12, 18]);
  });

  it("a business set to manual only (weight 0) is never given a lead automatically", async () => {
    env = await buildRouting();
    const auto = await env.s.activeClient(env.owner, { name: "Auto" });
    const manual = await env.s.activeClient(env.owner, { name: "Manual" });
    await env.prefs(manual, { weight: 0 });
    await env.turnOn();
    await route(6);
    const held = await env.holdings();
    expect(held.get(auto)).toBe(6);
    expect(held.get(manual)).toBeUndefined();
  });

  it("stops at a business's daily cap and moves on, and a lead taken back frees the room", async () => {
    env = await buildRouting();
    const capped = await env.s.activeClient(env.owner, { name: "Capped" });
    const other = await env.s.activeClient(env.owner, { name: "Other" });
    await env.prefs(capped, { priority: 1, dailyCap: 3 });
    await env.prefs(other, { priority: 50 });
    await env.turnOn();
    const results = await route(5);
    expect(results.map((result) => result.client)).toEqual([capped, capped, capped, other, other]);

    // Taking one back from the capped business frees a place for the next lead (counts are of leads it HOLDS). The lead that was taken
    // back is routed first (it is older), and goes to the OTHER business: the capped one already had it and gave it back.
    const [first] = await env.assignmentsOf(results[0]!.lead);
    await env.s.assignments.cancel({ operator: env.staff, assignmentId: first!.id, reason: "client_unavailable", requestId: env.s.rid() });
    const next = await insertRawLead(env.t.admin);
    expect(await env.routing.drain()).toMatchObject({ assigned: 2 });
    expect((await env.assignmentsOf(results[0]!.lead)).at(-1)!.client_id).toBe(other);
    expect((await env.assignmentsOf(next.id))[0]!.client_id).toBe(capped);
  });

  it("stops at a business's monthly cap", async () => {
    env = await buildRouting();
    const capped = await env.s.activeClient(env.owner, { name: "Capped" });
    const other = await env.s.activeClient(env.owner, { name: "Other" });
    await env.prefs(capped, { priority: 1, monthlyCap: 2 });
    await env.prefs(other, { priority: 50 });
    await env.turnOn();
    expect((await route(4)).map((result) => result.client)).toEqual([capped, capped, other, other]);
  });

  it("counts a business's day in ITS OWN time zone", async () => {
    env = await buildRouting();
    const london = await env.s.activeClient(env.owner, { name: "London" });
    const sydney = await env.s.activeClient(env.owner, { name: "Sydney" });
    const fallback = await env.s.activeClient(env.owner, { name: "Fallback" });
    await env.prefs(london, { priority: 1, dailyCap: 1 });
    await env.prefs(sydney, { priority: 2, dailyCap: 1, timezone: "Australia/Sydney" });
    await env.prefs(fallback, { priority: 99 });

    // Each already received one lead at 20:00 UTC on 5 October. For London (BST, UTC+1) that was BEFORE its day began at 23:00 UTC;
    // for Sydney (AEDT, UTC+11) it was AFTER its day began at 13:00 UTC, so it counts as "today" there.
    for (const clientId of [london, sydney]) {
      const earlier = await insertRawLead(env.t.admin, { status: "new" });
      await insertRawAssignment(env.t.admin, earlier.id, { clientId });
      await env.t.admin.updateTable("leads").set({ status: "assigned" }).where("id", "=", earlier.id).execute();
      await env.t.admin.updateTable("lead_assignments").set({ created_at: new Date("2026-10-05T20:00:00Z") }).where("lead_id", "=", earlier.id).execute();
    }
    await env.turnOn();
    env.clock.at = new Date("2026-10-06T00:30:00Z"); // 01:30 in London, 11:30 in Sydney, both on 6 October

    const first = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect((await env.assignmentsOf(first.id))[0]!.client_id).toBe(london); // London has had none today: it is first in priority
    // The assignment is stamped with the real clock; arrange it at the injected one so "today" means what the decision thinks it means.
    await env.t.admin.updateTable("lead_assignments").set({ created_at: env.clock.at }).where("lead_id", "=", first.id).execute();
    const second = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect((await env.assignmentsOf(second.id))[0]!.client_id).toBe(fallback); // London is now at its cap; Sydney already has its one today
    const detail = (await env.runsOf(second.id))[0]!.candidates as { clients: Array<{ name: string; excludedBy: string[] }> };
    expect(detail.clients.find((client) => client.name === "Sydney")?.excludedBy).toEqual(["daily_cap_reached"]);
  });
});

describe("working hours and pauses", () => {
  const MONDAY_10_LONDON = new Date("2026-10-05T09:00:00Z"); // BST (UTC+1): 10:00 local

  it("offers a lead only inside the hours, in the business's own time zone (summer and winter)", async () => {
    env = await buildRouting();
    const day = await env.s.activeClient(env.owner, { name: "Day" });
    const always = await env.s.activeClient(env.owner, { name: "Always" });
    await env.prefs(day, { priority: 1 });
    await env.prefs(always, { priority: 50 });
    await env.hours(day, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "09:00", closes: "17:00" })));
    await env.turnOn();

    const winnerAt = async (at: string) => {
      env.clock.at = new Date(at);
      const lead = await insertRawLead(env.t.admin);
      await env.routing.routeNext();
      const [assignment] = await env.assignmentsOf(lead.id);
      return assignment!.client_id === day ? "day" : "always";
    };
    expect(await winnerAt("2026-10-05T09:00:00Z")).toBe("day"); // Mon 10:00 BST
    expect(await winnerAt("2026-10-05T07:30:00Z")).toBe("always"); // Mon 08:30 BST: not open yet
    expect(await winnerAt("2026-10-05T15:50:00Z")).toBe("always"); // Mon 16:50 BST: within the 15-minute grace before closing
    expect(await winnerAt("2026-10-05T16:30:00Z")).toBe("always"); // Mon 17:30 BST: closed
    expect(await winnerAt("2026-10-10T10:00:00Z")).toBe("always"); // Saturday
    // Winter: the clocks have gone back, so 09:30 UTC is 09:30 GMT (open) and 08:30 UTC is 08:30 GMT (closed).
    expect(await winnerAt("2026-12-07T09:30:00Z")).toBe("day"); // Mon 7 Dec
    expect(await winnerAt("2026-12-07T08:30:00Z")).toBe("always");
  });

  it("reads the weekday and the time on the BUSINESS's clock, even where that is a different day from UTC", async () => {
    env = await buildRouting();
    const sydney = await env.s.activeClient(env.owner, { name: "Sydney" });
    const fallback = await env.s.activeClient(env.owner, { name: "Fallback" });
    await env.prefs(sydney, { priority: 1, timezone: "Australia/Sydney" });
    await env.prefs(fallback, { priority: 50 });
    await env.hours(sydney, [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "09:00", closes: "17:00" })));
    await env.turnOn();

    const winnerAt = async (at: string) => {
      env.clock.at = new Date(at);
      const lead = await insertRawLead(env.t.admin);
      await env.routing.routeNext();
      return (await env.assignmentsOf(lead.id))[0]!.client_id === sydney ? "sydney" : "fallback";
    };
    // AEDT is UTC+11 on these dates.
    expect(await winnerAt("2026-10-04T23:30:00Z")).toBe("sydney"); // Sunday in UTC, but Monday 10:30 in Sydney: open
    expect(await winnerAt("2026-10-05T07:00:00Z")).toBe("fallback"); // Monday 07:00 UTC is Monday 18:00 in Sydney: closed
    expect(await winnerAt("2026-10-09T23:30:00Z")).toBe("fallback"); // Friday in UTC, but Saturday 10:30 in Sydney: closed
    expect(await winnerAt("2026-10-09T05:00:00Z")).toBe("sydney"); // Friday 16:00 in Sydney: open (the grace stops it at 16:45)
    expect(await winnerAt("2026-10-09T05:50:00Z")).toBe("fallback"); // Friday 16:50 in Sydney: inside the 15-minute grace before closing
  });

  it("the day and the time both come from the business's clock, not the server's or UTC's (a night shift in Sydney)", async () => {
    env = await buildRouting();
    const night = await env.s.activeClient(env.owner, { name: "Night shift" });
    const fallback = await env.s.activeClient(env.owner, { name: "Fallback" });
    await env.prefs(night, { priority: 1, timezone: "Australia/Sydney" });
    await env.prefs(fallback, { priority: 50 });
    await env.hours(night, [{ weekday: 2, opens: "01:00", closes: "03:00" }]); // Tuesdays, 01:00-03:00 Sydney time only
    await env.turnOn();

    const winnerAt = async (at: string) => {
      env.clock.at = new Date(at);
      const lead = await insertRawLead(env.t.admin);
      await env.routing.routeNext();
      return (await env.assignmentsOf(lead.id))[0]!.client_id === night ? "night" : "fallback";
    };
    // It is Monday afternoon in London and in UTC, and already Tuesday 01:30 in Sydney (AEDT, UTC+11).
    expect(await winnerAt("2026-10-05T14:30:00Z")).toBe("night");
    expect(await winnerAt("2026-10-05T16:30:00Z")).toBe("fallback"); // Sydney Tuesday 03:30: closed
    expect(await winnerAt("2026-10-06T14:30:00Z")).toBe("fallback"); // Tuesday afternoon in London, Wednesday 01:30 in Sydney: closed
  });

  it("does not offer a lead during a pause, and does again when it ends", async () => {
    env = await buildRouting();
    const away = await env.s.activeClient(env.owner, { name: "Away" });
    const home = await env.s.activeClient(env.owner, { name: "Home" });
    await env.prefs(away, { priority: 1 });
    await env.prefs(home, { priority: 50 });
    await env.pause(away, new Date("2026-10-05T00:00:00Z"), new Date("2026-10-12T00:00:00Z"));
    await env.turnOn();

    env.clock.at = MONDAY_10_LONDON;
    const during = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect((await env.assignmentsOf(during.id))[0]!.client_id).toBe(home);
    const detail = (await env.runsOf(during.id))[0]!.candidates as { clients: Array<{ name: string; excludedBy: string[]; detail: { pausedUntil?: string } }> };
    expect(detail.clients.find((client) => client.name === "Away")).toMatchObject({ excludedBy: ["paused"], detail: { pausedUntil: "2026-10-12T00:00:00.000Z" } });

    env.clock.at = new Date("2026-10-12T00:00:01Z");
    const after = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect((await env.assignmentsOf(after.id))[0]!.client_id).toBe(away);
  });

  it("a business that is not active, offers another service, or does not cover the postcode is never a candidate", async () => {
    env = await buildRouting();
    const paused = await env.s.activeClient(env.owner, { name: "Status" });
    await env.s.clients.setStatus({ operator: env.owner, clientId: paused, status: "paused", reason: "paused_by_client", requestId: env.s.rid() });
    await env.s.activeClient(env.owner, { name: "Elsewhere", outward: ["TN13"] });
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "no_candidates" });
    const detail = (await env.runsOf(lead.id))[0]!.candidates as { notCovered: Array<{ name: string; reasons: string[] }> };
    expect(detail.notCovered.map((entry) => [entry.name, entry.reasons])).toEqual([["Elsewhere", ["no_include_rule_matches"]], ["Status", ["client_not_active"]]]);
  });
});

describe("rules are data", () => {
  it("only an owner may edit a rule; a stale edit is refused; every change is versioned and audited", async () => {
    env = await buildRouting();
    const [rule] = (await env.routing.overview()).rules.filter((candidate) => candidate.type === "working_hours");
    expect(await env.routing.updateRule({ operator: env.staff, ruleId: rule!.id, expectedVersion: 1, active: false, config: { graceMinutes: 5 }, requestId: env.s.rid() })).toEqual({ ok: false, code: "forbidden" });
    expect(await env.routing.updateRule({ operator: env.owner, ruleId: rule!.id, expectedVersion: 1, active: true, config: { graceMinutes: 500 }, requestId: env.s.rid() })).toMatchObject({ ok: false, code: "invalid_config" });
    expect(await env.routing.updateRule({ operator: env.owner, ruleId: rule!.id, expectedVersion: 1, active: true, config: { graceMinutes: 30 }, requestId: env.s.rid() })).toEqual({ ok: true });
    expect(await env.routing.updateRule({ operator: env.owner, ruleId: rule!.id, expectedVersion: 1, active: true, config: { graceMinutes: 45 }, requestId: env.s.rid() })).toEqual({ ok: false, code: "stale" });

    const after = (await env.routing.overview()).rules.find((candidate) => candidate.id === rule!.id)!;
    expect(after).toMatchObject({ version: 2, config: { graceMinutes: 30 } });
    const audit = await env.t.admin.selectFrom("audit_logs").select(["action", "before", "after"]).where("action", "=", "routing.rule_changed").execute();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ before: { config: { graceMinutes: 15 }, version: 1 }, after: { config: { graceMinutes: 30 }, version: 2 } });
  });

  it("switching the cap rule off makes caps stop applying, with no deploy; the run records which rules were in force", async () => {
    env = await buildRouting();
    const capped = await env.s.activeClient(env.owner, { name: "Capped" });
    await env.s.activeClient(env.owner, { name: "Other" });
    await env.prefs(capped, { priority: 1, dailyCap: 1 });
    await env.turnOn();
    const rule = (await env.routing.overview()).rules.find((candidate) => candidate.type === "daily_cap")!;
    await env.routing.updateRule({ operator: env.owner, ruleId: rule.id, expectedVersion: rule.version, active: false, config: {}, requestId: env.s.rid() });

    const leads = [await insertRawLead(env.t.admin), await insertRawLead(env.t.admin), await insertRawLead(env.t.admin)];
    for (let i = 0; i < 3; i++) await env.routing.routeNext();
    expect(await Promise.all(leads.map(async (lead) => (await env.assignmentsOf(lead.id))[0]!.client_id))).toEqual([capped, capped, capped]);
    const run = (await env.runsOf(leads[0]!.id))[0]!;
    expect((run.rules as Array<{ type: string }>).map((entry) => entry.type)).not.toContain("daily_cap");
  });

  it("reordering the rankers changes who wins", async () => {
    env = await buildRouting();
    const vip = await env.s.activeClient(env.owner, { name: "Vip" });
    const fresh = await env.s.activeClient(env.owner, { name: "Fresh" });
    await env.prefs(vip, { priority: 1 });
    await env.prefs(fresh, { priority: 50 });
    await env.turnOn();
    const first = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect((await env.assignmentsOf(first.id))[0]!.client_id).toBe(vip); // priority first

    // Fairness first: the business with no leads yet now beats the one with a better priority.
    const rankers = (await env.routing.overview()).rules.filter((rule) => rule.kind === "ranker");
    const priority = rankers.find((rule) => rule.type === "priority")!;
    expect(await env.routing.moveRule({ operator: env.owner, ruleId: priority.id, direction: "down", requestId: env.s.rid() })).toEqual({ ok: true });
    const second = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    expect((await env.assignmentsOf(second.id))[0]!.client_id).toBe(fresh);

    expect(await env.routing.moveRule({ operator: env.owner, ruleId: priority.id, direction: "down", requestId: env.s.rid() })).toEqual({ ok: true });
    const end = (await env.routing.overview()).rules.filter((rule) => rule.kind === "ranker").map((rule) => rule.type);
    expect(end).toEqual(["weighted_fairness", "least_recently_assigned", "priority"]);
    expect(await env.routing.moveRule({ operator: env.owner, ruleId: priority.id, direction: "down", requestId: env.s.rid() })).toMatchObject({ ok: false, code: "cannot_move" });
    const limiter = (await env.routing.overview()).rules.find((rule) => rule.type === "daily_cap")!;
    expect(await env.routing.moveRule({ operator: env.owner, ruleId: limiter.id, direction: "up", requestId: env.s.rid() })).toMatchObject({ ok: false, code: "cannot_move" });
  });

  it("a run keeps the rules as they were, however they are edited later", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    const rule = (await env.routing.overview()).rules.find((candidate) => candidate.type === "working_hours")!;
    await env.routing.updateRule({ operator: env.owner, ruleId: rule.id, expectedVersion: rule.version, active: true, config: { graceMinutes: 60 }, requestId: env.s.rid() });
    const [run] = await env.runsOf(lead.id);
    expect((run!.rules as Array<{ type: string; config: unknown; version: number }>).find((entry) => entry.type === "working_hours")).toMatchObject({ config: { graceMinutes: 15 }, version: 1 });
  });
});

describe("the record cannot be rewritten", () => {
  it("routing runs are append-only, even for the owner", async () => {
    env = await buildRouting();
    await env.s.activeClient(env.owner);
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin);
    await env.routing.routeNext();
    const [run] = await env.runsOf(lead.id);
    await expect(sql`update routing_runs set outcome = 'error' where id = ${run!.id}`.execute(env.t.admin)).rejects.toThrow(/append-only|cannot be/i);
    await expect(sql`delete from routing_runs where id = ${run!.id}`.execute(env.t.admin)).rejects.toThrow(/append-only|cannot be/i);
    await expect(sql`update routing_runs set outcome = 'error' where id = ${run!.id}`.execute(env.t.db)).rejects.toThrow();
  });

  it("an automatic assignment must have a run and nobody's name on it; a manual one must have a name", async () => {
    env = await buildRouting();
    const client = await env.s.activeClient(env.owner);
    const lead = await insertRawLead(env.t.admin);
    await sql`update leads set sale_model = 'exclusive' where id = ${lead.id}`.execute(env.t.admin);
    await expect(sql`insert into lead_assignments (lead_id, client_id, sale_type, assigned_by, price_pence) values (${lead.id}, ${client}, 'exclusive', 'router', 100)`.execute(env.t.admin)).rejects.toThrow(/router_has_run/);
    const { rows } = await sql<{ id: string }>`insert into routing_runs (lead_id, outcome, rules, algorithm_version, chosen_client_id) values (${lead.id}, 'assigned', '[]', 't', ${client}) returning id`.execute(env.t.admin);
    await expect(sql`insert into lead_assignments (lead_id, client_id, sale_type, assigned_by, assigned_by_user_id, routing_run_id, price_pence) values (${lead.id}, ${client}, 'exclusive', 'router', ${env.staff.id}, ${rows[0]!.id}, 100)`.execute(env.t.admin)).rejects.toThrow(/router_has_run/);
    await expect(sql`insert into routing_runs (lead_id, outcome, rules, algorithm_version) values (${lead.id}, 'assigned', '[]', 't')`.execute(env.t.admin)).rejects.toThrow(/chosen/);
  });
});
