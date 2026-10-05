import { sql } from "kysely";
import pino from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgConnectionConfig } from "../../src/lib/db/config";
import { ALERTS_CHANNEL } from "../../src/modules/alerts";
import { ROUTING_CHANNEL, createRoutingService, type RoutingService } from "../../src/modules/routing";
import { NOTIFICATIONS_CHANNEL, createDeliveryService } from "../../src/modules/delivery";
import { ScriptedChannel } from "../helpers/delivery";
import { createListener, type Listener } from "../../src/workers/listener";
import { createWorker, type Worker } from "../../src/workers/worker";
import { buildAlertService, ScriptedSender } from "../helpers/alerts";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildLeadService, command, validSubmission } from "../helpers/fixtures";
import { insertRawClient, insertRawLead } from "../helpers/raw";
import { buildStage3 } from "../helpers/stage3";

/**
 * The control loop around the alert service: do the three triggers (NOTIFY, poll, reconciler)
 * each get a lead's alert out, and does the loop survive the things that happen to long-running
 * processes (dropped connections, shutdown mid-send)? The delivery guarantees themselves are in
 * alerts-service.test.ts; the real-process crash test is in worker-process.test.ts.
 */
let t: TestDatabase;
let n = 40_000;
const next = () => (n += 1);
const silent = pino({ level: "silent" });

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

// Tests share one database: start each from an empty queue so one test's leftovers cannot satisfy or break another.
beforeEach(async () => {
  await sql`update operator_alerts set status = 'cancelled', locked_until = null where status in ('pending', 'retrying', 'sending')`.execute(t.admin);
});

const running: Worker[] = [];
afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop().catch(() => undefined);
});

const noListener = (): Listener => ({ start: async () => undefined, stop: async () => undefined });

function startWorker(
  sender: ScriptedSender,
  options: { pollMs?: number; reconcileMs?: number; listen?: boolean; graceSeconds?: number; shutdownGraceMs?: number; workerId?: string; housekeeping?: Array<{ name: string; run: () => Promise<unknown> }>; housekeepingEveryMs?: number } = {},
) {
  const worker = createWorker({
    db: t.db,
    alerts: buildAlertService(t.db, sender, { config: { graceSeconds: options.graceSeconds ?? 60 } }),
    logger: silent,
    workerId: options.workerId ?? `test-worker-${next()}`,
    pollMs: options.pollMs ?? 60_000,
    reconcileMs: options.reconcileMs ?? 60_000,
    shutdownGraceMs: options.shutdownGraceMs ?? 5_000,
    ...(options.housekeeping && { housekeeping: options.housekeeping }),
    ...(options.housekeepingEveryMs !== undefined && { housekeepingEveryMs: options.housekeepingEveryMs }),
    createListener: (onWake) =>
      options.listen === false
        ? noListener()
        : createListener({
            connection: pgConnectionConfig({ url: t.appUrl, applicationName: "leadgen-worker-listen-test" }),
            channel: ALERTS_CHANNEL,
            onWake,
            logger: silent,
            retryMinMs: 50,
            retryMaxMs: 200,
          }),
  });
  running.push(worker);
  return worker;
}

const submit = () => buildLeadService(t.db).submit(command(validSubmission({}, next())));
const waitFor = (condition: () => boolean | Promise<boolean>, timeout = 5_000) => expect.poll(condition, { timeout, interval: 25 }).toBe(true);

describe("the three triggers", () => {
  it("NOTIFY: a committed lead is alerted within a second even when polling is effectively off", async () => {
    const sender = new ScriptedSender();
    const worker = startWorker(sender, { pollMs: 60_000, reconcileMs: 60_000 });
    await worker.start();
    sender.calls.length = 0;

    const started = performance.now();
    const lead = await submit();
    await waitFor(() => sender.calls.some((call) => call.text.includes(lead.reference)), 3_000);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("polling: still delivered if no notification ever arrives (the safety net under NOTIFY)", async () => {
    const sender = new ScriptedSender();
    await startWorker(sender, { listen: false, pollMs: 150, reconcileMs: 60_000 }).start();
    const lead = await submit();
    await waitFor(() => sender.calls.some((call) => call.text.includes(lead.reference)), 3_000);
  });

  it("reconciler: a lead whose alert was never created is found, alerted and sent without any notification", async () => {
    const sender = new ScriptedSender();
    const lead = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 5 * 60_000) }); // raw insert: no alert row
    await startWorker(sender, { listen: false, pollMs: 60_000, reconcileMs: 200, graceSeconds: 1 }).start();
    await waitFor(() => sender.calls.some((call) => call.text.includes(lead.reference)), 3_000);
    expect((await t.admin.selectFrom("operator_alerts").select("status").where("lead_id", "=", lead.id).executeTakeFirstOrThrow()).status).toBe("sent");
  });

  it("a wake-up that arrives while a drain is running is not dropped", async () => {
    const sender = new ScriptedSender();
    const slow = { send: async (m: Parameters<ScriptedSender["send"]>[0], c: Parameters<ScriptedSender["send"]>[1]) => (await new Promise((r) => setTimeout(r, 250)), sender.send(m, c)) };
    const worker = createWorker({
      db: t.db,
      alerts: buildAlertService(t.db, slow),
      logger: silent,
      workerId: `test-worker-${next()}`,
      pollMs: 60_000,
      reconcileMs: 60_000,
      createListener: (onWake) =>
        createListener({ connection: pgConnectionConfig({ url: t.appUrl }), channel: ALERTS_CHANNEL, onWake, logger: silent }),
    });
    running.push(worker);
    await worker.start();
    sender.calls.length = 0;

    const first = await submit();
    await waitFor(() => t.admin.selectFrom("operator_alerts").select("status").where("lead_id", "=", first.leadId).executeTakeFirstOrThrow().then((row) => row.status === "sending"), 3_000);
    const second = await submit(); // arrives while the first send is in flight
    await waitFor(() => sender.calls.length === 2, 4_000);
    expect(sender.calls.map((call) => call.text.includes(first.reference) || call.text.includes(second.reference))).toEqual([true, true]);
  });
});

describe("a long-running process", () => {
  it("re-listens after its database connection is killed, and keeps getting woken by NOTIFY", async () => {
    const sender = new ScriptedSender();
    await startWorker(sender, { pollMs: 60_000, reconcileMs: 60_000 }).start();

    await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'leadgen-worker-listen-test'`.execute(t.admin);
    await new Promise((resolve) => setTimeout(resolve, 600)); // reconnect backoff

    sender.calls.length = 0;
    const lead = await submit();
    await waitFor(() => sender.calls.some((call) => call.text.includes(lead.reference)), 3_000);
  });

  it("catches up on alerts enqueued while the listener was down, as soon as it reconnects", async () => {
    const sender = new ScriptedSender();
    // Alert created BEFORE the worker exists: the notification is long gone.
    const lead = await submit();
    await startWorker(sender, { pollMs: 60_000, reconcileMs: 60_000 }).start();
    await waitFor(() => sender.calls.some((call) => call.text.includes(lead.reference)), 3_000);
  });

  it("writes a heartbeat while running, refreshes it, and removes it on a clean stop", async () => {
    const id = `heartbeat-worker-${next()}`;
    const worker = startWorker(new ScriptedSender(), { workerId: id, reconcileMs: 250, listen: false });
    await worker.start();
    const row = () => t.admin.selectFrom("worker_heartbeats").selectAll().where("worker_id", "=", id).executeTakeFirst();
    const first = await row();
    expect(first?.last_reconciled_at).toBeInstanceOf(Date);
    await waitFor(async () => ((await row())?.last_beat_at.getTime() ?? 0) > first!.last_beat_at.getTime(), 3_000);

    await worker.stop();
    expect(await row()).toBeUndefined();
  });

  it("RACE: stopping while a reconcile pass is still running leaves no heartbeat behind (the pass must not write it back)", async () => {
    const id = `heartbeat-race-${next()}`;
    const real = buildAlertService(t.db, new ScriptedSender(), { config: { graceSeconds: 60 } });
    let release!: () => void;
    let entered!: () => void;
    const hasEntered = new Promise<void>((resolve) => (entered = resolve));
    const worker = createWorker({
      db: t.db,
      alerts: { ...real, reconcile: async () => { entered(); await new Promise<void>((resolve) => (release = resolve)); return real.reconcile(); } },
      logger: silent,
      workerId: id,
      pollMs: 60_000,
      reconcileMs: 60_000,
      shutdownGraceMs: 5_000,
      createListener: noListener,
    });
    running.push(worker);
    const starting = worker.start(); // its first reconcile pass is now held open
    await hasEntered;
    const stopping = worker.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([starting, stopping]);
    expect(await t.admin.selectFrom("worker_heartbeats").select("worker_id").where("worker_id", "=", id).execute()).toEqual([]);
  });

  it("stop() lets an in-flight send finish before returning, and the alert ends up sent", async () => {
    let release!: () => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => (started = resolve));
    const sender = new ScriptedSender().queue(
      () =>
        new Promise((resolve) => {
          started();
          release = () => resolve({ outcome: "accepted", providerMessageId: "late" });
        }),
    );
    const worker = startWorker(sender, { listen: false, pollMs: 100 });
    const lead = await submit();
    await worker.start();
    await hasStarted;

    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stopped, "stop() returned while a send was still in flight").toBe(false);

    release();
    await stopping;
    expect((await t.admin.selectFrom("operator_alerts").select("status").where("lead_id", "=", lead.leadId).executeTakeFirstOrThrow()).status).toBe("sent");
  });

  it("stop() gives up waiting after its grace period, leaving the lease for the reconciler", async () => {
    const sender = new ScriptedSender().queue(() => new Promise(() => undefined)); // never completes
    const worker = startWorker(sender, { listen: false, pollMs: 100, shutdownGraceMs: 300 });
    const lead = await submit();
    await worker.start();
    await waitFor(async () => (await t.admin.selectFrom("operator_alerts").select("status").where("lead_id", "=", lead.leadId).executeTakeFirstOrThrow()).status === "sending", 3_000);
    const started = performance.now();
    await worker.stop();
    expect(performance.now() - started).toBeLessThan(2_000);
    expect((await t.admin.selectFrom("operator_alerts").select("status").where("lead_id", "=", lead.leadId).executeTakeFirstOrThrow()).status).toBe("sending");
  });
});

describe("the loop's edge cases, tested deterministically", () => {
  it("runs another round when a wake-up lands after the last claim returned empty but before the drain finished", async () => {
    // The narrow window: processDue() has just found nothing, and a NOTIFY arrives before the loop exits.
    // Without the re-run flag that wake-up would wait for the next poll (up to pollMs).
    let calls = 0;
    let release!: () => void;
    const firstCall = new Promise<void>((resolve) => (release = resolve));
    const alerts = {
      processDue: async () => {
        calls += 1;
        if (calls === 1) await firstCall;
        return { claimed: 0, sent: 0, retrying: 0, dead: 0, cancelled: 0 };
      },
      reconcile: async () => ({ requeued: 0, dead: 0, missingCreated: 0, remindersCreated: 0 }),
    };
    const worker = createWorker({
      db: t.db,
      alerts,
      logger: silent,
      workerId: "edge-case-worker",
      pollMs: 60_000,
      reconcileMs: 60_000,
      createListener: noListener,
    });
    worker.wake(); // starts a drain; its first processDue() is now pending
    await new Promise((resolve) => setTimeout(resolve, 20));
    worker.wake(); // arrives mid-drain
    release();
    await waitFor(() => calls >= 2, 2_000);
  });

  it("the listener wakes the worker on every (re)connect, to catch up on anything enqueued while it was away", async () => {
    let wakes = 0;
    const listener = createListener({
      connection: pgConnectionConfig({ url: t.appUrl, applicationName: "leadgen-catchup-test" }),
      channel: ALERTS_CHANNEL,
      onWake: () => (wakes += 1),
      logger: silent,
      retryMinMs: 50,
      retryMaxMs: 100,
    });
    await listener.start();
    try {
      expect(wakes).toBe(1); // initial connect
      await sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'leadgen-catchup-test'`.execute(t.admin);
      await waitFor(() => wakes >= 2, 3_000); // reconnected, and woke to catch up
    } finally {
      await listener.stop();
    }
  });

  it("rejects a LISTEN channel name that could inject SQL", () => {
    expect(() =>
      createListener({ connection: {}, channel: "x; drop table leads", onWake: () => undefined, logger: silent }),
    ).toThrow(/invalid LISTEN channel/);
  });
});

describe("routing in the worker (stage 4)", () => {
  let stage3: ReturnType<typeof buildStage3>;
  let owner: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
  let routing: RoutingService;

  beforeAll(async () => {
    stage3 = buildStage3(t);
    owner = await stage3.operator("owner@worker.test", "owner");
    await stage3.setPrice(owner);
    await stage3.activeClient(owner, { name: "Worker Roofing" });
    routing = createRoutingService({ db: t.db, logger: silent, verticalSlug: "roofing", isSuppressed: stage3.privacy.isSuppressed });
  });

  const switchRouting = async (enabled: boolean) => {
    const result = await routing.setEnabled({ operator: owner, enabled, requestId: stage3.rid() });
    if (!result.ok) throw new Error(result.code);
  };
  const statusOf = async (leadId: string) => (await t.admin.selectFrom("leads").select("status").where("id", "=", leadId).executeTakeFirstOrThrow()).status;

  function startRoutingWorker(
    sender: { send: ScriptedSender["send"] },
    options: { listen?: boolean; pollMs?: number; reconcileMs?: number } = {},
  ) {
    const worker = createWorker({
      db: t.db,
      alerts: buildAlertService(t.db, sender),
      routing,
      logger: silent,
      workerId: `test-routing-worker-${next()}`,
      pollMs: options.pollMs ?? 60_000,
      reconcileMs: options.reconcileMs ?? 60_000,
      shutdownGraceMs: 2_000,
      createListener: () => noListener(),
      createRoutingListener: (onWake) =>
        options.listen === false
          ? noListener()
          : createListener({
              connection: pgConnectionConfig({ url: t.appUrl, applicationName: "leadgen-worker-routing-listen-test" }),
              channel: ROUTING_CHANNEL,
              onWake,
              logger: silent,
              retryMinMs: 50,
              retryMaxMs: 200,
            }),
    });
    running.push(worker);
    return worker;
  }

  it("NOTIFY: a lead is assigned within a second of arriving, even when polling is effectively off", async () => {
    await switchRouting(true);
    await startRoutingWorker(new ScriptedSender(), { pollMs: 60_000, reconcileMs: 60_000 }).start();
    const started = performance.now();
    const lead = await submit();
    await waitFor(async () => (await statusOf(lead.leadId)) === "assigned", 3_000);
    expect(performance.now() - started).toBeLessThan(1_000);
    const [assignment] = await t.admin.selectFrom("lead_assignments").select(["assigned_by", "routing_run_id"]).where("lead_id", "=", lead.leadId).execute();
    expect(assignment).toMatchObject({ assigned_by: "router" });
    expect(assignment!.routing_run_id).toBeTruthy();
  });

  it("polling: still routed if no notification ever arrives (the safety net under NOTIFY)", async () => {
    await switchRouting(true);
    await startRoutingWorker(new ScriptedSender(), { listen: false, pollMs: 150, reconcileMs: 60_000 }).start();
    const lead = await submit();
    await waitFor(async () => (await statusOf(lead.leadId)) === "assigned", 4_000);
  });

  it("a stuck email provider never delays routing: the two jobs have separate loops", async () => {
    await switchRouting(true);
    const hung = { send: () => new Promise<never>(() => undefined) };
    await startRoutingWorker(hung, { pollMs: 100, reconcileMs: 60_000 }).start(); // polling wakes the alert loop too (this worker has no alert listener)
    const first = await submit();
    await waitFor(() => t.admin.selectFrom("operator_alerts").select("status").where("lead_id", "=", first.leadId).executeTakeFirstOrThrow().then((row) => row.status === "sending"), 3_000); // the alert loop is now stuck
    const second = await submit();
    await waitFor(async () => (await statusOf(second.leadId)) === "assigned", 3_000);
  });

  it("switched off, nothing is routed; switched on, it takes effect without restarting the worker, for leads arriving from then on", async () => {
    await switchRouting(false);
    await startRoutingWorker(new ScriptedSender(), { pollMs: 100, reconcileMs: 60_000 }).start();
    const waiting = await submit();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await statusOf(waiting.leadId)).toBe("new");

    await switchRouting(true);
    const after = await submit();
    await waitFor(async () => (await statusOf(after.leadId)) === "assigned", 3_000);
    expect(await statusOf(waiting.leadId)).toBe("new"); // it arrived before routing was switched on: left for a person
  });

  it("a lead that cannot be routed is parked and the loop keeps going for the next one", async () => {
    await switchRouting(true);
    await startRoutingWorker(new ScriptedSender(), { pollMs: 100, reconcileMs: 60_000 }).start();
    await t.admin.updateTable("routing_rules").set({ config: JSON.stringify({ graceMinutes: 9999 }) }).where("type", "=", "working_hours").execute(); // no longer validates
    const broken = await submit();
    await waitFor(async () => (await statusOf(broken.leadId)) === "unroutable", 3_000);
    expect((await t.admin.selectFrom("routing_runs").select(["outcome", "error"]).where("lead_id", "=", broken.leadId).executeTakeFirstOrThrow())).toEqual({ outcome: "error", error: "rules_invalid" });

    await t.admin.updateTable("routing_rules").set({ config: JSON.stringify({ graceMinutes: 15 }) }).where("type", "=", "working_hours").execute();
    const fine = await submit();
    await waitFor(async () => (await statusOf(fine.leadId)) === "assigned", 3_000);
  });
});

describe("delivery in the worker (stage 5)", () => {
  let stage3: ReturnType<typeof buildStage3>;
  let owner: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
  let clientId: string;
  const sms = new ScriptedChannel<{ to: string; body: string; notificationId: string }>();

  beforeAll(async () => {
    stage3 = buildStage3(t);
    owner = await stage3.operator("owner@worker-delivery.test", "owner");
    await stage3.setPrice(owner);
    clientId = await stage3.activeClient(owner, { name: "Texted Roofing" });
    await t.admin.updateTable("clients").set({ delivery_mode: "automatic", delivery_enabled_at: new Date(), notify_email: false, notify_sms: true }).where("id", "=", clientId).execute();
  });

  function startDeliveryWorker(options: { listen?: boolean; pollMs?: number } = {}) {
    const delivery = createDeliveryService({ db: t.db, logger: silent, senders: { email: new ScriptedSender(), sms }, config: { brandName: "T", leaseSeconds: 60, sendTimeoutMs: 2_000, batchSize: 5 } });
    const worker = createWorker({
      db: t.db,
      alerts: buildAlertService(t.db, new ScriptedSender()),
      delivery,
      logger: silent,
      workerId: `test-delivery-worker-${next()}`,
      pollMs: options.pollMs ?? 60_000,
      reconcileMs: 60_000,
      shutdownGraceMs: 2_000,
      createListener: () => noListener(),
      createDeliveryListener: (onWake) =>
        options.listen === false
          ? noListener()
          : createListener({ connection: pgConnectionConfig({ url: t.appUrl, applicationName: "leadgen-worker-delivery-listen-test" }), channel: NOTIFICATIONS_CHANNEL, onWake, logger: silent, retryMinMs: 50, retryMaxMs: 200 }),
    });
    running.push(worker);
    return worker;
  }
  const assignNew = async () => {
    const lead = await submit();
    const result = await stage3.assignments.assign({ operator: owner, leadId: lead.leadId, clientId, requestId: stage3.rid() });
    if (!result.ok) throw new Error(result.code);
    return { ...lead, assignmentId: result.assignmentId };
  };
  const status = async (assignmentId: string) => (await t.admin.selectFrom("lead_assignments").select("status").where("id", "=", assignmentId).executeTakeFirstOrThrow()).status;

  it("NOTIFY: an assignment is delivered within a second even when polling is effectively off", async () => {
    await startDeliveryWorker().start();
    const begun = performance.now();
    const assignment = await assignNew();
    await waitFor(async () => (await status(assignment.assignmentId)) === "notified", 3_000);
    expect(performance.now() - begun).toBeLessThan(1_000);
  });

  it("polling: still delivered if no notification ever arrives (the safety net under NOTIFY)", async () => {
    await startDeliveryWorker({ listen: false, pollMs: 150 }).start();
    const assignment = await assignNew();
    await waitFor(async () => (await status(assignment.assignmentId)) === "notified", 4_000);
  });

  it("a slow business never delays another: the provider call for one lead does not block the next", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    sms.queue(async () => {
      await gate;
      return { outcome: "accepted", providerMessageId: "SM" + "d".repeat(32) };
    });
    await startDeliveryWorker().start();
    const slow = await assignNew();
    await waitFor(() => t.admin.selectFrom("notifications").select("status").where("assignment_id", "=", slow.assignmentId).executeTakeFirstOrThrow().then((row) => row.status === "sending"), 3_000);
    const quick = await assignNew();
    await waitFor(async () => (await status(quick.assignmentId)) === "notified", 4_000); // the batch runs in parallel: the hung call does not hold it up
    release();
    await waitFor(async () => (await status(slow.assignmentId)) === "notified", 3_000);
  });
});

describe("housekeeping", () => {
  it("runs at start-up and then on its own schedule; one task failing never stops the others", async () => {
    let good = 0;
    let bad = 0;
    const worker = startWorker(new ScriptedSender(), {
      reconcileMs: 250,
      housekeepingEveryMs: 400,
      housekeeping: [
        { name: "fails", run: async () => { bad += 1; throw new Error("boom"); } },
        { name: "works", run: async () => { good += 1; } },
      ],
    });
    await worker.start();
    expect(good).toBe(1); // at start-up, not after an hour
    expect(bad).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(good).toBeGreaterThanOrEqual(2);
    expect(good).toBeLessThanOrEqual(4); // passes happen every 250 ms but the tasks only every 400 ms: about three runs in 1.2 s, not five or six
    expect(good).toBe(bad);
    await worker.stop();
  });

  it("clears out old business sign-in links and sessions, and nothing recent", async () => {
    const { cleanUpClientCredentials } = await import("../../src/modules/clientauth");
    const client = await insertRawClient(t.admin);
    const user = await t.admin.insertInto("client_users").values({ client_id: client.id, email: `hk-${next()}@x.example`, name: "H" }).returning("id").executeTakeFirstOrThrow();
    const hash = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    await sql`insert into client_login_tokens (user_id, token_hash, created_at, expires_at) values (${user.id}, ${hash()}, now() - interval '20 days', now() - interval '19 days'), (${user.id}, ${hash()}, now(), now() + interval '15 minutes')`.execute(t.admin);
    await sql`insert into client_sessions (user_id, token_hash, created_at, expires_at, last_seen_at) values (${user.id}, ${hash()}, now() - interval '30 days', now() - interval '16 days', now() - interval '16 days'), (${user.id}, ${hash()}, now(), now() + interval '14 days', now())`.execute(t.admin);
    const cleared = await cleanUpClientCredentials(t.db);
    expect(cleared.links).toBeGreaterThanOrEqual(1);
    expect(cleared.sessions).toBeGreaterThanOrEqual(1);
    const left = await sql<{ n: string }>`select (select count(*) from client_login_tokens where user_id = ${user.id}) + (select count(*) from client_sessions where user_id = ${user.id}) as n`.execute(t.admin);
    expect(Number(left.rows[0]!.n)).toBe(2); // the recent link and the live session
  });
});
