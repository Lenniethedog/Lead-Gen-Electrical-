import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LEAD_EVENT } from "../../src/config/lead-events";
import { enqueueOperatorAlert, getPipelineHealth, recordHeartbeat } from "../../src/modules/alerts";
import pino from "pino";
import { getRoutingHealth } from "../../src/modules/routing";
import { createPipelineHandler } from "../../src/server/handlers/pipeline";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawLead } from "../helpers/raw";

/** The four independent questions /api/pipeline asks, against the real schema. */
let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});
beforeEach(async () => {
  await sql`truncate worker_heartbeats`.execute(t.admin);
  await sql`update operator_alerts set status = 'cancelled', locked_until = null where status <> 'cancelled' and status <> 'sent'`.execute(t.admin);
  await sql`update leads set status = 'invalid' where status in ('new', 'held')`.execute(t.admin);
});

const beat = (workerId = "w1") => recordHeartbeat(t.db, { workerId, reconciled: true });
const problems = async () => (await getPipelineHealth(t.db)).problems;

describe("worker liveness", () => {
  it("is stale when no worker has ever reported, and OK right after a heartbeat", async () => {
    expect(await problems()).toEqual(["worker_stale"]);
    await beat();
    expect(await problems()).toEqual([]);
  });

  it("goes stale when the last heartbeat is older than 90 s", async () => {
    await beat();
    await sql`update worker_heartbeats set last_beat_at = now() - interval '89 seconds'`.execute(t.admin);
    expect(await problems()).toEqual([]);
    await sql`update worker_heartbeats set last_beat_at = now() - interval '91 seconds'`.execute(t.admin);
    expect(await problems()).toEqual(["worker_stale"]);
  });

  it("is healthy while ANY of several workers is alive (a crashed one does not mask a live one)", async () => {
    await beat("old");
    await sql`update worker_heartbeats set last_beat_at = now() - interval '1 hour' where worker_id = 'old'`.execute(t.admin);
    await beat("new");
    expect(await problems()).toEqual([]);
  });
});

describe("overdue alerts", () => {
  it("flags an alert that was due more than 2 minutes ago and is still not sent", async () => {
    await beat();
    const lead = await insertRawLead(t.admin);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    expect(await problems()).toEqual([]); // freshly due: fine
    await sql`update operator_alerts set next_attempt_at = now() - interval '3 minutes' where lead_id = ${lead.id}`.execute(t.admin);
    expect(await problems()).toEqual(["alerts_overdue"]);
  });

  it("flags an alert stuck 'sending' under an expired lease", async () => {
    await beat();
    const lead = await insertRawLead(t.admin);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    await sql`update operator_alerts set status = 'sending', attempt_count = 1, locked_until = now() - interval '3 minutes' where lead_id = ${lead.id}`.execute(t.admin);
    expect(await problems()).toEqual(["alerts_overdue"]);
  });

  it("does not flag an alert that is merely waiting for its retry time", async () => {
    await beat();
    const lead = await insertRawLead(t.admin);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    await sql`update operator_alerts set status = 'retrying', attempt_count = 1, next_attempt_at = now() + interval '30 seconds' where lead_id = ${lead.id}`.execute(t.admin);
    expect(await problems()).toEqual([]);
  });
});

describe("dead alerts", () => {
  async function deadAlertFor(status: "new" | "held" = "new") {
    const lead = await insertRawLead(t.admin, status === "held" ? { status: "held", fraudDecision: "review" } : {});
    await enqueueOperatorAlert(t.db, { id: lead.id, status });
    await sql`update operator_alerts set status = 'dead', attempt_count = 8 where lead_id = ${lead.id}`.execute(t.admin);
    return lead;
  }

  it("flags a dead alert while its lead still needs a human", async () => {
    await beat();
    await deadAlertFor();
    expect(await problems()).toEqual(["alerts_dead"]);
  });

  it("stops flagging once an operator has dealt with the lead (the alert's job was done by other means)", async () => {
    await beat();
    const lead = await deadAlertFor();
    await t.admin.insertInto("lead_events").values({ lead_id: lead.id, type: LEAD_EVENT.handled, actor_type: "staff_user", payload: "{}" }).execute();
    expect(await problems()).toEqual([]);
  });

  it("stops flagging once a held lead has been decided", async () => {
    await beat();
    const lead = await deadAlertFor("held");
    expect(await problems()).toEqual(["alerts_dead"]);
    await t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'staff_user', true), set_config('app.actor_id', ${crypto.randomUUID()}, true), set_config('app.reason', 'spam_or_bot', true)`.execute(trx);
      await trx.updateTable("leads").set({ status: "rejected_fraud" }).where("id", "=", lead.id).execute();
    });
    expect(await problems()).toEqual([]);
  });
});

describe("leads nobody was told about", () => {
  it("flags a new lead older than 150 s with no alert row (the reconciler is not running)", async () => {
    await beat();
    await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 100_000) });
    expect(await problems()).toEqual([]); // inside the reconciler's own grace window
    await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 200_000) });
    expect(await problems()).toEqual(["leads_unalerted"]);
  });

  it("ignores test leads, screened-out leads and leads outside the 72 h look-back", async () => {
    await beat();
    const old = new Date(Date.now() - 10 * 60_000);
    const test = await insertRawLead(t.admin, { createdAt: old });
    await t.admin.updateTable("leads").set({ is_test: true }).where("id", "=", test.id).execute();
    await insertRawLead(t.admin, { status: "rejected_fraud", fraudDecision: "reject", createdAt: old });
    await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 100 * 3_600_000) });
    expect(await problems()).toEqual([]);
  });

  it("reports several problems at once, so one cannot mask another", async () => {
    await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 200_000) });
    expect((await problems()).sort()).toEqual(["leads_unalerted", "worker_stale"]);
  });
});

describe("routing (stage 4)", () => {
  const routingProblems = async () => (await getRoutingHealth(t.db)).problems;
  const switchOn = async (enabledAgo = "1 hour") => {
    await sql`insert into routing_settings (vertical_id, enabled, enabled_at) select id, true, now() - ${enabledAgo}::interval from verticals where slug = 'roofing'
              on conflict (vertical_id) do update set enabled = true, enabled_at = excluded.enabled_at`.execute(t.admin);
  };
  const switchOff = () => sql`update routing_settings set enabled = false`.execute(t.admin);

  beforeEach(async () => {
    await switchOff();
    await sql`update leads set status = 'invalid' where status in ('new', 'held', 'unroutable')`.execute(t.admin);
    // Runs are append-only, so the owner switches the guard off for one statement to start each test clean.
    await sql`alter table routing_runs disable trigger routing_runs_append_only`.execute(t.admin);
    await sql`delete from routing_runs`.execute(t.admin);
    await sql`alter table routing_runs enable trigger routing_runs_append_only`.execute(t.admin);
  });

  it("is healthy when routing is off, however many leads wait (nothing is supposed to be routing them)", async () => {
    await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 600_000) });
    expect(await routingProblems()).toEqual([]);
  });

  it("flags a lead the router should have taken that is still waiting after 60 s: the router is not running", async () => {
    await switchOn();
    const lead = await insertRawLead(t.admin);
    expect(await routingProblems()).toEqual([]); // just arrived: the router has a moment
    await sql`update leads set created_at = now() - interval '61 seconds' where id = ${lead.id}`.execute(t.admin);
    expect(await routingProblems()).toEqual(["routing_stalled"]);
  });

  it("does not flag leads the router would never take: older than routing, handled, taken back for a person, test, held, or too old", async () => {
    await switchOn("10 minutes");
    const old = (overrides: Parameters<typeof insertRawLead>[1] = {}) => insertRawLead(t.admin, { createdAt: new Date(Date.now() - 300_000), ...overrides });
    await old(); // arrived 5 minutes ago, but routing was only switched on 10 minutes ago: this one IS routable
    await sql`update leads set status = 'invalid' where status in ('new', 'held', 'unroutable')`.execute(t.admin); // reset
    const before = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 3_600_000) }); // before routing was switched on
    const handled = await old();
    await t.admin.insertInto("lead_events").values({ lead_id: handled.id, type: LEAD_EVENT.handled, actor_type: "staff_user" }).execute();
    const stopped = await old();
    await t.admin.insertInto("lead_events").values({ lead_id: stopped.id, type: LEAD_EVENT.routingStopped, actor_type: "staff_user" }).execute();
    await old({ isTest: true });
    await old({ status: "held", fraudDecision: "review" });
    expect(before.id).toBeTruthy();
    expect(await routingProblems()).toEqual([]);
  });

  it("flags routing as failing while an error run is recent, and clears after 10 minutes", async () => {
    await switchOn();
    const lead = await insertRawLead(t.admin);
    await sql`insert into routing_runs (lead_id, outcome, rules, algorithm_version, error) values (${lead.id}, 'error', '[]', 't', 'exception')`.execute(t.admin);
    expect(await routingProblems()).toEqual(["routing_failing"]);
    await sql`update leads set status = 'invalid' where status in ('new', 'held', 'unroutable')`.execute(t.admin);
    // Runs are append-only, so age is arranged by the owner switching the trigger off for this one statement.
    await sql`alter table routing_runs disable trigger routing_runs_append_only`.execute(t.admin);
    await sql`update routing_runs set created_at = now() - interval '11 minutes'`.execute(t.admin);
    await sql`alter table routing_runs enable trigger routing_runs_append_only`.execute(t.admin);
    expect(await routingProblems()).toEqual([]);
  });

  it("a lead the router parked (unroutable) is not 'stalled': it has been looked at", async () => {
    await switchOn();
    const lead = await insertRawLead(t.admin, { status: "unroutable", createdAt: new Date(Date.now() - 300_000) });
    expect(lead.id).toBeTruthy();
    expect(await routingProblems()).toEqual([]);
  });

  it("/api/pipeline reports routing problems alongside the alerting ones, as codes only", async () => {
    await beat();
    await switchOn();
    const lead = await insertRawLead(t.admin);
    await sql`update leads set created_at = now() - interval '90 seconds' where id = ${lead.id}`.execute(t.admin);
    const handler = createPipelineHandler({ db: t.db, logger: pino({ level: "silent" }), ttlMs: 0 });
    const response = await handler();
    expect(response.status).toBe(503);
    const body = (await response.json()) as { status: string; problems: string[] };
    expect(body.status).toBe("degraded");
    expect(body.problems).toContain("routing_stalled");
    expect(JSON.stringify(body)).not.toContain(lead.reference);

    await sql`update leads set status = 'unroutable' where id = ${lead.id}`.execute(t.admin);
    const healthy = await createPipelineHandler({ db: t.db, logger: pino({ level: "silent" }), ttlMs: 0 })();
    expect(healthy.status).toBe(200);
  });
});
