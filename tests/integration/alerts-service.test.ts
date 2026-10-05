import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEAD_EVENT } from "../../src/config/lead-events";
import { claimDueAlerts, markSent } from "../../src/modules/alerts/repo";
import { enqueueOperatorAlert } from "../../src/modules/alerts";
import { buildAlertService, captureLogger, drain, ScriptedSender } from "../helpers/alerts";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildLeadService, command, validSubmission } from "../helpers/fixtures";
import { insertRawLead } from "../helpers/raw";

let t: TestDatabase;
let n = 20_000;
const next = () => (n += 1);

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

/** A lead with its alert, as the lead service would have created it. */
async function leadWithAlert(overrides: Parameters<typeof insertRawLead>[1] = {}) {
  const lead = await insertRawLead(t.admin, overrides);
  await enqueueOperatorAlert(t.db, { id: lead.id, status: overrides.status ?? "new" });
  return lead;
}

const alertOf = (leadId: string, kind = "new_lead") =>
  t.admin.selectFrom("operator_alerts").selectAll().where("lead_id", "=", leadId).where("kind", "=", kind as "new_lead").executeTakeFirstOrThrow();
const attemptsOf = (alertId: string) =>
  t.admin.selectFrom("operator_alert_attempts").selectAll().where("alert_id", "=", alertId).orderBy("attempt_no").execute();
const makeDue = (alertId: string) =>
  sql`update operator_alerts set next_attempt_at = now() - interval '1 second' where id = ${alertId}`.execute(t.admin);
const expireLease = (alertId: string) =>
  sql`update operator_alerts set locked_until = now() - interval '1 second' where id = ${alertId}`.execute(t.admin);

/** Every alert in this database is processed by whichever test runs, so each test claims only its own. */
async function isolate(): Promise<void> {
  await sql`update operator_alerts set status = 'cancelled' where status in ('pending', 'retrying')`.execute(t.admin);
}

describe("delivering an alert", () => {
  it("sends one email with the reference, area and a link, marks it sent and records the attempt", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const sender = new ScriptedSender();
    await drain(buildAlertService(t.db, sender));

    expect(sender.calls).toHaveLength(1);
    const email = sender.calls[0]!;
    expect(email.to).toEqual(["ops@example.com"]);
    expect(email.subject).toContain(lead.reference);
    expect(email.subject).toContain("BR6");
    expect(email.text).toContain(`https://admin.test.example/admin/leads/${lead.id}`);

    const alert = await alertOf(lead.id);
    expect(alert).toMatchObject({ status: "sent", attempt_count: 1, provider_message_id: "msg_1", locked_until: null, last_error_code: null });
    expect(alert.sent_at).toBeInstanceOf(Date);
    expect(email.idempotencyKey).toBe(`operator-alert-${alert.id}`);

    const attempts = await attemptsOf(alert.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt_no: 1, outcome: "accepted", error_code: null });
    expect(attempts[0]!.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("does not send an alert twice once it is sent", async () => {
    await isolate();
    await leadWithAlert();
    const sender = new ScriptedSender();
    const service = buildAlertService(t.db, sender);
    await drain(service);
    await drain(service);
    expect(sender.calls).toHaveLength(1);
  });

  it("puts NO personal data in the email or anywhere in the alert tables", async () => {
    await isolate();
    // A real lead through the real service, with distinctive contact details in every personal field.
    const marker = next();
    const result = await buildLeadService(t.db).submit(
      command(
        validSubmission(
          { contact: { name: "Zebediah Quillfeather", phone: `07911 1${String(marker).slice(-5)}`, email: `zebediah.${marker}@quill.example`, notes: "Gate code 4821, ring twice" } },
          marker,
        ),
      ),
    );
    const contact = await t.admin.selectFrom("lead_contacts").select(["phone_e164", "email"]).where("lead_id", "=", result.leadId).executeTakeFirstOrThrow();
    const sender = new ScriptedSender();
    const capture = captureLogger();
    await drain(buildAlertService(t.db, sender, { logger: capture.logger }));

    const email = sender.calls.find((call) => call.text.includes(result.reference))!;
    const everything = [
      email.subject,
      email.text,
      JSON.stringify(await t.admin.selectFrom("operator_alerts").selectAll().execute()),
      JSON.stringify(await t.admin.selectFrom("operator_alert_attempts").selectAll().execute()),
      capture.text(),
    ].join("\n");
    for (const secret of ["Zebediah", "Quillfeather", contact.phone_e164!, contact.email!, "zebediah.", "quill.example", "Gate code", "4821", "BR6 0AA", "0AA"]) {
      expect(everything, `leaked "${secret}"`).not.toContain(secret);
    }
    expect(email.text).toContain("BR6"); // the outward code is deliberately included
  });

  it("alerts held leads differently, so the operator knows a decision is needed", async () => {
    await isolate();
    const lead = await insertRawLead(t.admin, { status: "held", fraudDecision: "review" });
    await t.admin.updateTable("leads").set({ fraud_score: 55 }).where("id", "=", lead.id).execute();
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "held" });
    const sender = new ScriptedSender();
    await drain(buildAlertService(t.db, sender));
    expect(sender.calls[0]!.subject).toContain("needs review");
    expect(sender.calls[0]!.text).toContain("Screened into manual review (score 55)");
  });
});

describe("when the provider fails", () => {
  it("retries a retryable failure after the documented delay, then succeeds, recording both attempts", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const sender = new ScriptedSender().queue({ outcome: "retryable_failure", errorCode: "http_503", httpStatus: 503 });
    const service = buildAlertService(t.db, sender);

    await service.processDue();
    let alert = await alertOf(lead.id);
    expect(alert).toMatchObject({ status: "retrying", attempt_count: 1, last_error_code: "http_503", locked_until: null });
    const waitMs = alert.next_attempt_at.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(3_500); // first delay is 5 s (zero jitter in tests)
    expect(waitMs).toBeLessThanOrEqual(5_000);

    expect((await service.processDue()).claimed).toBe(0); // not due yet: nothing is claimed

    await makeDue(alert.id);
    await drain(service);
    alert = await alertOf(lead.id);
    expect(alert).toMatchObject({ status: "sent", attempt_count: 2, last_error_code: null });
    expect((await attemptsOf(alert.id)).map((attempt) => [attempt.attempt_no, attempt.outcome, attempt.error_code, attempt.http_status])).toEqual([
      [1, "retryable_failure", "http_503", 503],
      [2, "accepted", null, null],
    ]);
    expect(sender.delivered.size).toBe(1);
  });

  it("a thrown error from the sender is treated as retryable, never as a crash", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const service = buildAlertService(t.db, new ScriptedSender().queue("throw"));
    await service.processDue();
    expect(await alertOf(lead.id)).toMatchObject({ status: "retrying", last_error_code: "sender_exception" });
  });

  it("gives up on a permanent failure immediately and says so loudly", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const capture = captureLogger();
    const sender = new ScriptedSender().queue({ outcome: "permanent_failure", errorCode: "validation_error", httpStatus: 422 });
    await buildAlertService(t.db, sender, { logger: capture.logger }).processDue();

    expect(await alertOf(lead.id)).toMatchObject({ status: "dead", attempt_count: 1, last_error_code: "validation_error" });
    expect(capture.lines.some((line) => line.level === "error" && String(line.msg).includes("dead"))).toBe(true);
  });

  it("buries an alert after eight failed attempts, with one attempt row each", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const failing: Array<{ outcome: "retryable_failure"; errorCode: string }> = Array.from({ length: 8 }, () => ({ outcome: "retryable_failure", errorCode: "http_500" }));
    const sender = new ScriptedSender().queue(...failing);
    const service = buildAlertService(t.db, sender);

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const alert = await alertOf(lead.id);
      expect(alert.status).toBe(attempt === 1 ? "pending" : "retrying");
      await makeDue(alert.id);
      await service.processDue();
    }
    const dead = await alertOf(lead.id);
    expect(dead).toMatchObject({ status: "dead", attempt_count: 8, last_error_code: "http_500" });
    expect(await attemptsOf(dead.id)).toHaveLength(8);
    expect(sender.calls).toHaveLength(8);

    await makeDue(dead.id);
    expect((await service.processDue()).claimed).toBe(0); // dead alerts are never claimed again
  });

  it("times out a provider that never answers, records it as a timeout, and retries", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const hang = (_message: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const sender = new ScriptedSender().queue(hang);
    const started = performance.now();
    await buildAlertService(t.db, sender, { config: { sendTimeoutMs: 150 } }).processDue();

    expect(performance.now() - started).toBeLessThan(3_000);
    const alert = await alertOf(lead.id);
    expect(alert).toMatchObject({ status: "retrying", last_error_code: "timeout" });
    expect((await attemptsOf(alert.id))[0]).toMatchObject({ outcome: "timeout" });
  });

  it("treats 'no recipients configured' as a loud, retryable configuration problem, not a lost alert", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const sender = new ScriptedSender();
    await buildAlertService(t.db, sender, { config: { recipients: [] } }).processDue();
    expect(sender.calls).toHaveLength(0);
    expect(await alertOf(lead.id)).toMatchObject({ status: "retrying", last_error_code: "no_recipients" });
  });

  it("stores only a sanitised short error code", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const sender = new ScriptedSender().queue({ outcome: "retryable_failure", errorCode: "Owner@Example.com said: NO!!" });
    await buildAlertService(t.db, sender).processDue();
    expect((await alertOf(lead.id)).last_error_code).toMatch(/^[a-z0-9_]{1,60}$/);
  });
});

describe("a worker that dies, freezes, or races (the part that must never lose a lead)", () => {
  it("never claims the same alert twice: 6 workers x 40 alerts send each exactly once", async () => {
    await isolate();
    const leads = await Promise.all(Array.from({ length: 40 }, () => leadWithAlert()));
    const sender = new ScriptedSender();
    // A little latency makes the workers genuinely overlap.
    const slow = { send: async (message: Parameters<ScriptedSender["send"]>[0], ctx: Parameters<ScriptedSender["send"]>[1]) => (await new Promise((r) => setTimeout(r, 5)), sender.send(message, ctx)) };
    const workers = Array.from({ length: 6 }, () => buildAlertService(t.db, slow));
    await Promise.all(workers.map((worker) => drain(worker)));

    expect(sender.calls).toHaveLength(40);
    expect(new Set(sender.calls.map((call) => call.idempotencyKey)).size).toBe(40);
    const rows = await t.admin.selectFrom("operator_alerts").select(["status", "attempt_count"]).where("lead_id", "in", leads.map((lead) => lead.id)).execute();
    expect(rows.every((row) => row.status === "sent" && row.attempt_count === 1)).toBe(true);
  });

  it("never waits behind another worker's locked row: it claims the other alerts instead (SKIP LOCKED)", async () => {
    await isolate();
    const first = await leadWithAlert();
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct next_attempt_at ordering
    const second = await leadWithAlert();
    const firstAlert = await alertOf(first.id);

    // Another worker is part-way through claiming the OLDEST alert: it holds that row's lock.
    const { Client } = await import("pg");
    const locker = new Client({ connectionString: t.ownerUrl });
    await locker.connect();
    await locker.query("begin");
    await locker.query("select id from operator_alerts where id = $1 for update", [firstAlert.id]);
    try {
      const outcome = await Promise.race([
        claimDueAlerts(t.db, { limit: 5, leaseSeconds: 60 }).then((claimed) => ({ claimed })),
        new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 2_000)),
      ]);
      expect(outcome, "claim blocked behind a locked row instead of skipping it").not.toHaveProperty("timedOut");
      const claimed = (outcome as { claimed: Awaited<ReturnType<typeof claimDueAlerts>> }).claimed;
      expect(claimed.map((alert) => alert.leadId)).toEqual([second.id]);
    } finally {
      await locker.query("rollback");
      await locker.end();
    }
  });

  it("recovers an alert whose worker died mid-send: the lease expires, the reconciler requeues it, another worker sends it", async () => {
    await isolate();
    const lead = await leadWithAlert();
    // The "dead worker": it claimed the alert and then vanished (no completion, no cleanup).
    const claimed = await claimDueAlerts(t.db, { limit: 5, leaseSeconds: 60 });
    expect(claimed).toHaveLength(1);
    expect(await alertOf(lead.id)).toMatchObject({ status: "sending", attempt_count: 1 });

    const sender = new ScriptedSender();
    const service = buildAlertService(t.db, sender);
    expect((await service.processDue()).claimed).toBe(0); // still leased: nobody else may take it
    expect(await service.reconcile()).toMatchObject({ requeued: 0 }); // lease not expired: the reconciler leaves it alone

    await expireLease(claimed[0]!.id);
    expect(await service.reconcile()).toMatchObject({ requeued: 1, dead: 0 });
    await drain(service);

    const alert = await alertOf(lead.id);
    expect(alert).toMatchObject({ status: "sent", attempt_count: 2 });
    expect((await attemptsOf(alert.id)).map((attempt) => [attempt.attempt_no, attempt.outcome, attempt.error_code])).toEqual([
      [1, "abandoned", "lease_expired"],
      [2, "accepted", null],
    ]);
    expect(sender.calls).toHaveLength(1);
  });

  it("the provider accepted but the worker died before recording it: the retry reuses the idempotency key, so only ONE email exists", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const provider = new ScriptedSender();
    const alert = await alertOf(lead.id);

    // Worker A (the REAL service): the provider accepts the email, then A is killed while waiting for the answer.
    provider.queue(provider.acceptThenHang());
    void buildAlertService(t.db, provider).processDue();
    await expect.poll(() => provider.delivered.size, { timeout: 3_000 }).toBe(1);

    // Worker B takes over after the lease expires.
    await expireLease(alert.id);
    const service = buildAlertService(t.db, provider);
    await service.reconcile();
    await drain(service);

    expect(provider.calls).toHaveLength(2); // two SEND CALLS...
    expect(provider.delivered.size).toBe(1); // ...but the provider, given the same key and payload, produced ONE email
    expect(provider.calls[0]!.idempotencyKey).toBe(provider.calls[1]!.idempotencyKey);
    expect((await alertOf(lead.id)).status).toBe("sent");
  });

  describe("against a provider that enforces payload-aware idempotency (Resend: the same key + a different payload is a 409)", () => {
    /** The provider accepts the alert's email, then the worker dies: the alert is left `sending` under an expired lease. */
    async function crashAfterAccept(provider: ScriptedSender, alertId: string) {
      provider.queue(provider.acceptThenHang());
      void buildAlertService(t.db, provider).processDue();
      await expect.poll(() => provider.delivered.size, { timeout: 3_000 }).toBeGreaterThan(0);
      await expireLease(alertId);
    }

    it("a HELD lead approved between the attempts still sends an identical retry: one email, no 409", async () => {
      await isolate();
      const lead = await insertRawLead(t.admin, { status: "held", fraudDecision: "review" });
      await t.admin.updateTable("leads").set({ fraud_score: 55 }).where("id", "=", lead.id).execute();
      await enqueueOperatorAlert(t.db, { id: lead.id, status: "held" });
      const provider = new ScriptedSender();
      await crashAfterAccept(provider, (await alertOf(lead.id, "held_lead")).id);

      // The operator approves it while the alert is stranded: the lead's CURRENT status changes.
      await t.admin.transaction().execute(async (trx) => {
        await sql`select set_config('app.actor_type', 'staff_user', true), set_config('app.actor_id', ${crypto.randomUUID()}, true), set_config('app.reason', 'genuine', true)`.execute(trx);
        await trx.updateTable("leads").set({ status: "new" }).where("id", "=", lead.id).execute();
      });

      const service = buildAlertService(t.db, provider);
      await service.reconcile();
      await drain(service);
      expect((await alertOf(lead.id, "held_lead")).status).toBe("sent");
      expect(provider.delivered.size).toBe(1);
      expect(provider.calls[1]!.text).toBe(provider.calls[0]!.text); // byte-identical retry
      expect((await attemptsOf((await alertOf(lead.id, "held_lead")).id)).map((attempt) => attempt.outcome)).toEqual(["abandoned", "accepted"]);
    });

    it("a REMINDER retried after a crash is identical too (it says '15+ min', never a changing wait)", async () => {
      await isolate();
      const lead = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 30 * 60_000) });
      await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
      await t.admin.updateTable("operator_alerts").set({ status: "sent", sent_at: new Date() }).where("lead_id", "=", lead.id).where("kind", "=", "new_lead").execute();
      await buildAlertService(t.db, new ScriptedSender()).reconcile(); // queues the reminder
      const reminder = await alertOf(lead.id, "reminder");
      const provider = new ScriptedSender();
      await crashAfterAccept(provider, reminder.id);

      await new Promise((resolve) => setTimeout(resolve, 1_200)); // time passes: a clock-dependent subject would now differ
      const service = buildAlertService(t.db, provider);
      await service.reconcile();
      await drain(service);

      expect((await alertOf(lead.id, "reminder")).status).toBe("sent");
      expect(provider.delivered.size).toBe(1);
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[1]!.subject).toBe(provider.calls[0]!.subject);
      expect(provider.calls[1]!.subject).toContain("still waiting (15+ min)");
    });

    it("if the payload still differs (recipients changed mid-retry) the provider's 409 is NOT retried uselessly: the next attempt uses a fresh key and is delivered", async () => {
      await isolate();
      const lead = await leadWithAlert();
      const alertRow = await alertOf(lead.id);
      const provider = new ScriptedSender();
      await crashAfterAccept(provider, alertRow.id); // delivered once to ops@example.com under key K

      // Worker B was restarted with a different recipient list: same key, different payload.
      const service = buildAlertService(t.db, provider, { config: { recipients: ["ops@example.com", "second.operator@example.com"] } });
      await service.reconcile();
      await service.processDue();
      let alert = await alertOf(lead.id);
      expect(alert).toMatchObject({ status: "retrying", last_error_code: "invalid_idempotent_request" });
      expect(provider.delivered.size).toBe(1);

      await makeDue(alert.id);
      await drain(service);
      alert = await alertOf(lead.id);
      expect(alert.status).toBe("sent"); // not lost
      expect(provider.delivered.size).toBe(2); // the documented, tolerated duplicate
      const keys = provider.calls.map((call) => call.idempotencyKey);
      expect(keys[0]).toBe(`operator-alert-${alertRow.id}`);
      expect(keys[1]).toBe(keys[0]); // the mismatching attempt reused the key...
      expect(keys[2]).toBe(`operator-alert-${alertRow.id}-r3`); // ...and the next one rotated it
      expect((await attemptsOf(alert.id)).map((attempt) => [attempt.outcome, attempt.error_code, attempt.http_status])).toEqual([
        ["abandoned", "lease_expired", null],
        ["retryable_failure", "invalid_idempotent_request", 409],
        ["accepted", null, null],
      ]);
    });

    it("only a payload mismatch rotates the key: a 409 for a request merely still in flight is retried under the SAME key", async () => {
      await isolate();
      const lead = await leadWithAlert();
      const provider = new ScriptedSender().queue({ outcome: "retryable_failure", errorCode: "concurrent_idempotent_requests", httpStatus: 409 });
      const service = buildAlertService(t.db, provider);
      await service.processDue();
      await makeDue((await alertOf(lead.id)).id);
      await drain(service);
      expect(provider.calls[1]!.idempotencyKey).toBe(provider.calls[0]!.idempotencyKey);
      expect((await alertOf(lead.id)).status).toBe("sent");
    });
  });

  it("a frozen worker that wakes up after its lease was reclaimed cannot overwrite the newer state", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const capture = captureLogger();

    // Worker A claims and its provider call hangs (the process is paused, GC'd, or the network stalls).
    let releaseA: (() => void) | undefined;
    let aStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => (aStarted = resolve));
    const senderA = new ScriptedSender().queue(
      () =>
        new Promise((resolve) => {
          aStarted!();
          releaseA = () => resolve({ outcome: "accepted", providerMessageId: "late_from_A" });
        }),
    );
    const workerA = buildAlertService(t.db, senderA, { logger: capture.logger });
    const inFlightA = workerA.processDue();
    await started;

    // Meanwhile the lease expires; the reconciler requeues; worker B sends and records success.
    const alert = await alertOf(lead.id);
    await expireLease(alert.id);
    const senderB = new ScriptedSender();
    const workerB = buildAlertService(t.db, senderB);
    await workerB.reconcile();
    await drain(workerB);
    expect(await alertOf(lead.id)).toMatchObject({ status: "sent", attempt_count: 2, provider_message_id: "msg_1" });

    // A wakes up. Its late result must change nothing and add no second attempt row.
    releaseA!();
    const summary = await inFlightA;
    expect(summary.sent).toBe(0);
    expect(await alertOf(lead.id)).toMatchObject({ status: "sent", attempt_count: 2, provider_message_id: "msg_1" });
    expect((await attemptsOf(alert.id)).map((attempt) => attempt.outcome)).toEqual(["abandoned", "accepted"]);
    expect(capture.lines.some((line) => String(line.msg).includes("after its lease was reclaimed"))).toBe(true);
  });

  it("a frozen worker that wakes up while the NEW worker is still mid-send cannot complete the new worker's attempt", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const gate = () => {
      let release!: () => void;
      let started!: () => void;
      const hasStarted = new Promise<void>((resolve) => (started = resolve));
      const step = () =>
        new Promise<{ outcome: "accepted"; providerMessageId: string }>((resolve) => {
          started();
          release = () => resolve({ outcome: "accepted", providerMessageId: "gated" });
        });
      return { step, hasStarted, release: () => release() };
    };
    const a = gate();
    const b = gate();
    const workerA = buildAlertService(t.db, new ScriptedSender().queue(a.step));
    const workerB = buildAlertService(t.db, new ScriptedSender().queue(b.step));

    const inFlightA = workerA.processDue();
    await a.hasStarted;
    const alert = await alertOf(lead.id);
    await expireLease(alert.id);
    await workerB.reconcile();
    const inFlightB = workerB.processDue();
    await b.hasStarted;
    expect(await alertOf(lead.id)).toMatchObject({ status: "sending", attempt_count: 2 });

    // A (attempt 1) finishes first. It must NOT be allowed to mark B's attempt 2 as done.
    a.release();
    expect((await inFlightA).sent).toBe(0);
    expect(await alertOf(lead.id)).toMatchObject({ status: "sending", attempt_count: 2 });

    b.release();
    expect((await inFlightB).sent).toBe(1);
    expect(await alertOf(lead.id)).toMatchObject({ status: "sent", attempt_count: 2 });
    expect((await attemptsOf(alert.id)).map((attempt) => [attempt.attempt_no, attempt.outcome])).toEqual([
      [1, "abandoned"],
      [2, "accepted"],
    ]);
  });

  it("compare-and-set completion: only the attempt that holds the lease can finish the alert", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const alert = await alertOf(lead.id);
    const [claim] = await claimDueAlerts(t.db, { limit: 5, leaseSeconds: 60 });
    expect(claim!.attemptNo).toBe(1);
    expect(await markSent(t.db, { alertId: alert.id, attemptNo: 2 })).toBe(false); // wrong attempt number
    expect(await markSent(t.db, { alertId: alert.id, attemptNo: 1 })).toBe(true);
    expect(await markSent(t.db, { alertId: alert.id, attemptNo: 1 })).toBe(false); // already completed
  });

  it("buries (rather than loops forever on) an alert that keeps killing its worker", async () => {
    await isolate();
    const lead = await leadWithAlert();
    const alert = await alertOf(lead.id);
    await sql`update operator_alerts set max_attempts = 2 where id = ${alert.id}`.execute(t.admin);
    const service = buildAlertService(t.db, new ScriptedSender());

    for (let round = 0; round < 2; round += 1) {
      await claimDueAlerts(t.db, { limit: 5, leaseSeconds: 60 }); // claims, then "dies"
      await expireLease(alert.id);
      await service.reconcile();
    }
    expect(await alertOf(lead.id)).toMatchObject({ status: "dead", attempt_count: 2, last_error_code: "lease_expired" });
    expect((await attemptsOf(alert.id)).map((attempt) => attempt.outcome)).toEqual(["abandoned", "abandoned"]);
  });
});

describe("the reconciler: nothing is left unseen even if the enqueue path failed", () => {
  it("creates the missing alert for a new lead older than the grace period, and only then", async () => {
    await isolate();
    const old = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 90_000) });
    const fresh = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 10_000) });
    const service = buildAlertService(t.db, new ScriptedSender());

    const summary = await service.reconcile();
    expect(summary.missingCreated).toBeGreaterThanOrEqual(1);
    expect(await t.admin.selectFrom("operator_alerts").select("kind").where("lead_id", "=", old.id).execute()).toEqual([{ kind: "new_lead" }]);
    expect(await t.admin.selectFrom("operator_alerts").select("kind").where("lead_id", "=", fresh.id).execute()).toEqual([]);
  });

  it("uses held_lead for held leads and ignores leads nobody needs to act on", async () => {
    await isolate();
    const longAgo = new Date(Date.now() - 5 * 60_000);
    const held = await insertRawLead(t.admin, { status: "held", fraudDecision: "review", createdAt: longAgo });
    const original = await insertRawLead(t.admin, { createdAt: longAgo, status: "assigned" }); // really held by a client
    const bot = await insertRawLead(t.admin, { status: "rejected_fraud", fraudDecision: "reject", createdAt: longAgo });
    const test = await insertRawLead(t.admin, { createdAt: longAgo });
    await t.admin.updateTable("leads").set({ is_test: true }).where("id", "=", test.id).execute();
    const ancient = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 100 * 3_600_000) });

    await buildAlertService(t.db, new ScriptedSender()).reconcile();
    const kinds = async (id: string) => (await t.admin.selectFrom("operator_alerts").select("kind").where("lead_id", "=", id).execute()).map((row) => row.kind);
    expect(await kinds(held.id)).toEqual(["held_lead"]);
    expect(await kinds(original.id)).toEqual([]);
    expect(await kinds(bot.id)).toEqual([]);
    expect(await kinds(test.id)).toEqual([]);
    expect(await kinds(ancient.id)).toEqual([]); // outside the 72 h look-back: visible in the inbox, not re-alerted
  });

  it("is idempotent, and 8 reconcilers racing create exactly one alert per lead without a single error", async () => {
    await isolate();
    const leads = await Promise.all(Array.from({ length: 10 }, () => insertRawLead(t.admin, { createdAt: new Date(Date.now() - 120_000) })));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => buildAlertService(t.db, new ScriptedSender()).reconcile()));
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const rows = await t.admin.selectFrom("operator_alerts").select(["lead_id", "kind"]).where("lead_id", "in", leads.map((lead) => lead.id)).execute();
    expect(rows).toHaveLength(10);
    expect(await buildAlertService(t.db, new ScriptedSender()).reconcile()).toMatchObject({ missingCreated: 0 });
  });

  it("logs loudly when it has to create an alert that should already exist", async () => {
    await isolate();
    await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 120_000) });
    const capture = captureLogger();
    await buildAlertService(t.db, new ScriptedSender(), { logger: capture.logger }).reconcile();
    expect(capture.lines.some((line) => line.level === "error" && String(line.msg).includes("should already exist"))).toBe(true);
  });

  it("wakes the worker (NOTIFY) when it requeues or creates something", async () => {
    await isolate();
    const lead = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 120_000) });
    const { Client } = await import("pg");
    const listener = new Client({ connectionString: t.ownerUrl });
    await listener.connect();
    let notified = 0;
    listener.on("notification", () => (notified += 1));
    await listener.query("listen operator_alerts_due");
    try {
      await buildAlertService(t.db, new ScriptedSender()).reconcile();
      await expect.poll(() => notified, { timeout: 2_000 }).toBeGreaterThan(0);
      expect(lead.id).toBeTruthy();
    } finally {
      await listener.end();
    }
  });
});

describe("reminders: a lead left unhandled is raised once more, and only while it still needs someone", () => {
  const leadWaiting = (minutes: number, overrides: Parameters<typeof insertRawLead>[1] = {}) =>
    insertRawLead(t.admin, { createdAt: new Date(Date.now() - minutes * 60_000), ...overrides });

  it("queues one reminder after the delay, and not before", async () => {
    await isolate();
    const early = await leadWaiting(5);
    const late = await leadWaiting(20);
    for (const lead of [early, late]) await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    const service = buildAlertService(t.db, new ScriptedSender());

    await service.reconcile();
    const reminders = async (id: string) => t.admin.selectFrom("operator_alerts").select("kind").where("lead_id", "=", id).where("kind", "=", "reminder").execute();
    expect(await reminders(early.id)).toHaveLength(0);
    expect(await reminders(late.id)).toHaveLength(1);

    await service.reconcile();
    expect(await reminders(late.id)).toHaveLength(1); // once per lead, however often the reconciler runs
  });

  it("sends the reminder email with the wait time, then never again", async () => {
    await isolate();
    const lead = await leadWaiting(20);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    const sender = new ScriptedSender();
    const service = buildAlertService(t.db, sender);
    await service.reconcile();
    await drain(service);
    await service.reconcile();
    await drain(service);

    expect(sender.calls.map((call) => call.subject.includes("Reminder"))).toEqual([false, true]);
    expect(sender.calls[1]!.subject).toContain("still waiting (15+ min)");
  });

  it("never queues a reminder for a lead that was already handled", async () => {
    await isolate();
    const lead = await leadWaiting(30);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    await t.admin.insertInto("lead_events").values({ lead_id: lead.id, type: LEAD_EVENT.handled, actor_type: "staff_user", payload: "{}" }).execute();
    await buildAlertService(t.db, new ScriptedSender()).reconcile();
    expect(await t.admin.selectFrom("operator_alerts").select("kind").where("lead_id", "=", lead.id).where("kind", "=", "reminder").execute()).toHaveLength(0);
  });

  it("cancels a queued reminder at send time if the lead was handled in the meantime: no pointless nag", async () => {
    await isolate();
    const lead = await leadWaiting(30);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    const sender = new ScriptedSender();
    const service = buildAlertService(t.db, sender);
    await service.reconcile(); // queues the reminder (and the first alert is still pending)
    await t.admin.updateTable("operator_alerts").set({ status: "sent", sent_at: new Date() }).where("lead_id", "=", lead.id).where("kind", "=", "new_lead").execute();
    await t.admin.insertInto("lead_events").values({ lead_id: lead.id, type: LEAD_EVENT.handled, actor_type: "staff_user", payload: "{}" }).execute();

    await drain(service);
    expect(sender.calls).toHaveLength(0);
    expect(await alertOf(lead.id, "reminder")).toMatchObject({ status: "cancelled" });
  });

  it("also reminds about a lead nobody could route, and about an assigned lead that has not been SENT, until it is", async () => {
    await isolate();
    const unroutable = await leadWaiting(30, { status: "unroutable" });
    const unsent = await leadWaiting(30, { status: "assigned" });
    const sent = await leadWaiting(30, { status: "assigned" });
    await t.admin.updateTable("lead_assignments").set({ status: "notified" }).where("lead_id", "=", sent.id).execute();
    for (const lead of [unroutable, unsent, sent]) await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    const sender = new ScriptedSender();
    const service = buildAlertService(t.db, sender);
    await service.reconcile();

    expect(await alertOf(unroutable.id, "reminder")).toMatchObject({ status: "pending" });
    expect(await alertOf(unsent.id, "reminder")).toMatchObject({ status: "pending" });
    expect(await t.admin.selectFrom("operator_alerts").select("kind").where("lead_id", "=", sent.id).where("kind", "=", "reminder").execute()).toHaveLength(0);

    // The operator sends the assigned lead before the reminder goes out: no pointless nag.
    await t.admin.updateTable("lead_assignments").set({ status: "notified" }).where("lead_id", "=", unsent.id).execute();
    await t.admin.updateTable("operator_alerts").set({ status: "sent", sent_at: new Date() }).where("kind", "=", "new_lead").where("lead_id", "in", [unroutable.id, unsent.id, sent.id]).execute();
    await drain(service);
    expect(await alertOf(unsent.id, "reminder")).toMatchObject({ status: "cancelled" });
    expect(await alertOf(unroutable.id, "reminder")).toMatchObject({ status: "sent" });
  });

  it("also reminds about a held lead nobody has decided on, and stops once it is decided", async () => {
    await isolate();
    const lead = await leadWaiting(30, { status: "held", fraudDecision: "review" });
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "held" });
    await buildAlertService(t.db, new ScriptedSender()).reconcile();
    expect(await alertOf(lead.id, "reminder")).toMatchObject({ status: "pending" });

    await sql`select set_config('app.actor_type', 'staff_user', false)`.execute(t.admin);
    await t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'staff_user', true), set_config('app.actor_id', ${crypto.randomUUID()}, true), set_config('app.reason', 'spam_or_bot', true)`.execute(trx);
      await trx.updateTable("leads").set({ status: "rejected_fraud" }).where("id", "=", lead.id).execute();
    });
    const sender = new ScriptedSender();
    await drain(buildAlertService(t.db, sender));
    expect(sender.calls.filter((call) => call.subject.includes("Reminder"))).toHaveLength(0);
  });
});
