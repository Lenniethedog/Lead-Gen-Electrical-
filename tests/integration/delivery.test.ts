import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";
import { decryptSecret } from "../../src/lib/secrets";
import { buildDelivery, permanent, retryable, type DeliveryEnv } from "../helpers/delivery";
import { insertRawAssignment, insertRawLead } from "../helpers/raw";

/**
 * Telling a business about its lead (stage 5), against a real database and scriptable providers. What must hold: every automatic assignment
 * is notified exactly as configured, atomically with the assignment; a failure on one channel never loses the lead and never blocks another
 * channel; when every channel fails the lead is freed (and the router gives it to someone else); a crashed or frozen worker cannot cause a
 * lost notification or a second one; and nothing personal is stored outside lead_contacts.
 */
let env: DeliveryEnv;
afterEach(async () => {
  await env?.destroy();
});

describe("who gets notified", () => {
  it("a business on automatic delivery gets one notification per enabled channel, written with the assignment; a manual one gets none", async () => {
    env = await buildDelivery();
    const auto = await env.automaticClient(env.owner, { email: true, sms: true, name: "Auto" });
    const manual = await env.s.activeClient(env.owner, { name: "Manual" });
    const { assignmentId } = await env.assign(auto);
    expect((await env.notifications(assignmentId)).map((n) => [n.channel, n.status, n.attempt_count])).toEqual([["email", "pending", 0], ["sms", "pending", 0]]);
    const other = await env.assign(manual);
    expect(await env.notifications(other.assignmentId)).toHaveLength(0);
  });

  it("covers every way a lead gets assigned: by the router and by moving it from another business", async () => {
    env = await buildDelivery();
    const first = await env.s.activeClient(env.owner, { name: "First" });
    const second = await env.automaticClient(env.owner, { email: true, sms: true, webhook: true, name: "Second", outward: ["BR6"] });
    const { assignmentId, leadId } = await env.assign(first);
    const moved = await env.s.assignments.reassign({ operator: env.staff, assignmentId, toClientId: second, reason: "client_declined", requestId: env.s.rid() });
    if (!moved.ok) throw new Error(moved.code);
    expect((await env.notifications(moved.assignmentId)).map((n) => n.channel)).toEqual(["email", "sms", "webhook"]);

    // The router's own insert (a routing run, assigned_by router) goes through the same trigger.
    const lead = await insertRawLead(env.t.admin);
    const raw = await insertRawAssignment(env.t.admin, lead.id, { clientId: second });
    expect((await env.notifications(raw.id)).map((n) => n.channel)).toEqual(["email", "sms", "webhook"]);
    expect(leadId).toBeTruthy();
  });

  it("a business cannot be put on SMS without a phone number, or on webhook without a secret (the service and the database both refuse)", async () => {
    env = await buildDelivery();
    const id = await env.s.activeClient(env.owner);
    await env.t.admin.updateTable("clients").set({ contact_phone_e164: null }).where("id", "=", id).execute();
    const settings = { mode: "automatic" as const, email: true, sms: true, webhook: false, webhookUrl: null };
    expect(await env.clients.setDeliverySettings({ operator: env.owner, clientId: id, settings, requestId: env.s.rid() })).toEqual({ ok: false, code: "sms_needs_phone" });
    expect(await env.clients.setDeliverySettings({ operator: env.owner, clientId: id, settings: { ...settings, sms: false, webhook: true, webhookUrl: "https://x.example.com/h" }, requestId: env.s.rid() })).toEqual({ ok: false, code: "webhook_needs_secret" });
    await expect(sql`update clients set delivery_mode = 'automatic', delivery_enabled_at = now(), notify_email = true, notify_webhook = true where id = ${id}`.execute(env.t.admin)).rejects.toThrow(/webhook_ready/);
    await expect(sql`update clients set delivery_mode = 'automatic', delivery_enabled_at = now(), notify_email = false where id = ${id}`.execute(env.t.admin)).rejects.toThrow(/automatic_has_channel/);
  });
});

describe("a successful delivery", () => {
  it("emails the full details to the business's address and texts the minimum to its phone, then marks the assignment notified as the system", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    const lead = await insertRawLead(env.t.admin, { email: "margaret@example.com", phone: "+447123456789" });
    await env.t.admin.updateTable("lead_contacts").set({ full_name: "Margaret Oyelaran", notes: "Side gate code 4821" }).where("lead_id", "=", lead.id).execute();
    const { assignmentId } = await env.assign(client, env.staff, lead);

    expect(await env.drain()).toMatchObject({ claimed: 2, sent: 2 });

    const mail = env.email.calls[0]!;
    expect(mail.to).toHaveLength(1);
    expect(mail.to[0]).toMatch(/@electrician\.example$/);
    expect(mail.text).toContain("Margaret Oyelaran");
    expect(mail.text).toContain("+447123456789");
    expect(mail.text).toContain("BR6 0AA");
    expect(mail.text).toContain("4821");
    const text = env.sms.calls[0]!;
    expect(text.to).toBe("+447911123456");
    expect(text.body).toContain("Margaret,");
    expect(text.body).toContain("+447123456789");
    expect(text.body).not.toMatch(/Oyelaran|BR6 0AA|4821|margaret@/);

    const rows = await env.notifications(assignmentId);
    expect(rows.map((n) => [n.channel, n.status, n.attempt_count])).toEqual([["email", "sent", 1], ["sms", "sent", 1]]);
    expect(rows.every((n) => n.sent_at !== null && n.provider_message_id !== null)).toBe(true);
    expect((await env.attempts(rows[0]!.id))[0]).toMatchObject({ attempt_no: 1, outcome: "accepted" });

    const assignment = await env.assignmentRow(assignmentId);
    expect(assignment).toMatchObject({ status: "notified" });
    expect(assignment.notified_at).not.toBeNull();
    const history = await env.t.admin.selectFrom("lead_assignment_status_history").selectAll().where("assignment_id", "=", assignmentId).orderBy("id").execute();
    expect(history.at(-1)).toMatchObject({ from_status: "reserved", to_status: "notified", actor_type: "system", reason: "delivered_automatically" });
  });

  it("the email's idempotency key is stable per notification, and different between notifications", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true });
    const a = await env.assign(client);
    const b = await env.assign(client);
    await env.drain();
    const keys = env.email.calls.map((call) => call.idempotencyKey);
    const ids = [...(await env.notifications(a.assignmentId)), ...(await env.notifications(b.assignmentId))].map((n) => `delivery-${n.id}`);
    expect(new Set(keys)).toEqual(new Set(ids));
  });

  it("sends a webhook with the decrypted secret and the full signed body, keyed by the notification id", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, webhook: true });
    const { assignmentId } = await env.assign(client);
    await env.drain();
    const call = env.webhook.calls[0]!;
    const stored = await env.t.admin.selectFrom("clients").select(["webhook_secret_enc", "webhook_secret_hint"]).where("id", "=", client).executeTakeFirstOrThrow();
    expect(call.secret).toBe(decryptSecret(env.secretsKey, stored.webhook_secret_enc!));
    expect(call.secret.endsWith(stored.webhook_secret_hint!)).toBe(true);
    expect(stored.webhook_secret_enc).not.toContain(call.secret.slice(8, 20));
    expect(call.url).toBe("https://crm.example.com/hook");
    expect(call.deliveryId).toBe((await env.notifications(assignmentId))[0]!.id);
    expect(JSON.parse(call.body)).toMatchObject({ event: "lead.assigned", assignment_id: assignmentId, price: { pence: 3500 } });
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "notified" });
  });
});

describe("failures", () => {
  it("one channel failing permanently does not stop the other: the assignment is notified, and the failed channel is reported", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    const { assignmentId } = await env.assign(client);
    env.sms.queue(permanent("twilio_21211"));
    await env.drain();
    const rows = await env.notifications(assignmentId);
    expect(rows.map((n) => [n.channel, n.status])).toEqual([["email", "sent"], ["sms", "failed"]]);
    expect(rows[1]!.last_error_code).toBe("twilio_21211");
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "notified" });
    expect((await env.attempts(rows[1]!.id))[0]).toMatchObject({ outcome: "permanent_failure", error_code: "twilio_21211", http_status: 400 });
  });

  it("a retryable failure is retried with backoff, not before it is due, and then succeeds", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    env.sms.queue(retryable("http_503"));
    expect(await env.drain()).toMatchObject({ claimed: 1, retrying: 1 });
    const [row] = await env.notifications(assignmentId);
    expect(row).toMatchObject({ status: "retrying", attempt_count: 1, last_error_code: "http_503" });
    expect(row!.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 3_000); // 5 s +- jitter
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "reserved" }); // not told yet, not given up either

    expect(await env.drain()).toMatchObject({ claimed: 0 }); // not due
    await env.makeDue(row!.id);
    expect(await env.drain()).toMatchObject({ sent: 1 });
    const [after] = await env.notifications(assignmentId);
    expect(after).toMatchObject({ status: "sent", attempt_count: 2, last_error_code: null });
    expect((await env.attempts(row!.id)).map((a) => a.outcome)).toEqual(["retryable_failure", "accepted"]);
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "notified" });
  });

  it("a provider that throws or hangs past the timeout is retryable, with a safe error code", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    env.sms.queue("throw");
    await env.drain();
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "retrying", last_error_code: "sender_exception" });
    await env.makeDue((await env.notifications(assignmentId))[0]!.id);
    env.sms.queue((_, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" })))));
    await env.drain();
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "retrying", last_error_code: "timeout" });
  }, 15_000);

  it("a missing provider (SMS not configured) is retryable and reported, never silently dropped", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    const bare = env.make();
    // A worker with no SMS provider configured:
    const { createDeliveryService } = await import("../../src/modules/delivery");
    const pino = (await import("pino")).default;
    const noSms = createDeliveryService({ db: env.t.db, logger: pino({ level: "silent" }), senders: { email: env.email }, config: { brandName: "B", leaseSeconds: 60, sendTimeoutMs: 1_000, batchSize: 5 } });
    await env.drain(noSms);
    expect(bare).toBeDefined();
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "retrying", last_error_code: "channel_not_configured" });
  });

  it("every channel exhausting its attempts ends the assignment and frees the lead; the router then gives it to a DIFFERENT business", async () => {
    env = await buildDelivery();
    const failing = await env.automaticClient(env.owner, { email: true, sms: true, name: "Failing" });
    const backup = await env.s.activeClient(env.owner, { name: "Backup" });
    await env.t.admin.updateTable("clients").set({ priority: 500 }).where("id", "=", backup).execute();
    await env.t.admin.updateTable("clients").set({ priority: 1 }).where("id", "=", failing).execute();
    await env.routing.setEnabled({ operator: env.owner, enabled: true, requestId: env.s.rid() });

    const lead = await insertRawLead(env.t.admin, { email: "lead@example.com", phone: "+447900000001" });
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "assigned", clientId: failing });
    const assignment = (await env.t.admin.selectFrom("lead_assignments").selectAll().where("lead_id", "=", lead.id).executeTakeFirstOrThrow());
    env.email.queue(permanent("validation_error"));
    env.sms.queue(permanent("twilio_21211"));
    await env.drain();

    expect(await env.assignmentRow(assignment.id)).toMatchObject({ status: "delivery_failed" });
    const history = await env.t.admin.selectFrom("lead_assignment_status_history").selectAll().where("assignment_id", "=", assignment.id).orderBy("id").execute();
    expect(history.at(-1)).toMatchObject({ to_status: "delivery_failed", actor_type: "system", reason: "delivery_failed" });
    const events = await env.t.admin.selectFrom("lead_events").select(["type", "payload"]).where("lead_id", "=", lead.id).orderBy("id").execute();
    expect(events.map((e) => e.type)).toContain("lead.delivery_failed");
    expect(await env.leadStatus(lead.id)).toBe("new");

    // The business that could not be reached has already had this lead: it is not offered it again.
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "assigned", clientId: backup });
  });

  it("a lead whose only channel dies is freed too, via the reconciler when the last attempt's lease expired", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId, leadId } = await env.assign(client);
    const [row] = await env.notifications(assignmentId);
    // Its eighth attempt was in flight when the worker died.
    await env.t.admin.updateTable("notifications").set({ status: "sending", attempt_count: 8, locked_until: sql<Date>`now() - interval '1 minute'` }).where("id", "=", row!.id).execute();
    expect(await env.delivery.reconcile()).toMatchObject({ dead: 1, settled: 1 });
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "dead", last_error_code: "lease_expired" });
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "delivery_failed" });
    expect(await env.leadStatus(leadId)).toBe("new");
    expect((await env.attempts(row!.id)).at(-1)).toMatchObject({ outcome: "abandoned", error_code: "lease_expired" });
  });
});

describe("what the assignment waits for", () => {
  it("one channel giving up does NOT end the assignment while another is still being tried (the text may yet go out)", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    const { assignmentId, leadId } = await env.assign(client);
    env.email.queue(permanent("validation_error"));
    env.sms.queue(retryable("http_503"));
    await env.drain();
    expect((await env.notifications(assignmentId)).map((n) => [n.channel, n.status])).toEqual([["email", "failed"], ["sms", "retrying"]]);
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "reserved" }); // not failed yet, not notified yet
    expect(await env.leadStatus(leadId)).toBe("assigned");

    await env.makeDue((await env.notifications(assignmentId)).find((n) => n.channel === "sms")!.id);
    await env.drain();
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "notified" });
  });

  it("an ordinary failure on the LAST attempt gives up (dead) instead of retrying for ever", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId, leadId } = await env.assign(client);
    const [row] = await env.notifications(assignmentId);
    await env.t.admin.updateTable("notifications").set({ attempt_count: 7 }).where("id", "=", row!.id).execute();
    env.sms.queue(retryable("http_503"));
    await env.drain();
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "dead", attempt_count: 8, last_error_code: "http_503" });
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "delivery_failed" });
    expect(await env.leadStatus(leadId)).toBe("new");
  });

  it("a provider's payload-mismatch answer rotates the email's idempotency key for the next attempt, and only then", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true });
    const { assignmentId } = await env.assign(client);
    env.email.queue({ outcome: "retryable_failure", errorCode: "invalid_idempotent_request", httpStatus: 409 }, retryable("http_503"));
    await env.drain();
    const [row] = await env.notifications(assignmentId);
    await env.makeDue(row!.id);
    await env.drain();
    await env.makeDue(row!.id);
    await env.drain();
    const keys = env.email.calls.map((call) => call.idempotencyKey);
    expect(keys[0]).toBe(`delivery-${row!.id}`);
    expect(keys[1]).toBe(`delivery-${row!.id}-r2`); // after the 409: a fresh key
    expect(keys[2]).toBe(`delivery-${row!.id}`); // after an ordinary failure: back to the stable key
  });
});

describe("a worker that dies or freezes", () => {
  it("a notification abandoned mid-send is reclaimed, retried, and recorded as abandoned: never lost", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    const [row] = await env.notifications(assignmentId);
    await env.t.admin.updateTable("notifications").set({ status: "sending", attempt_count: 1, locked_until: sql<Date>`now() - interval '5 seconds'` }).where("id", "=", row!.id).execute();
    expect(await env.delivery.reconcile()).toMatchObject({ requeued: 1, dead: 0 });
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "retrying", last_error_code: "lease_expired" });
    await env.drain();
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "sent", attempt_count: 2 });
    expect((await env.attempts(row!.id)).map((a) => a.outcome)).toEqual(["abandoned", "accepted"]);
  });

  it("a frozen worker that wakes after its lease was reclaimed cannot overwrite the newer state, or record a second result", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    env.sms.queue(async () => {
      await gate;
      return { outcome: "accepted", providerMessageId: "SM_FROZEN" };
    });
    const frozen = env.delivery.processDue(); // claims it (attempt 1) and hangs in the provider call
    for (let i = 0; i < 100 && (await env.notifications(assignmentId))[0]!.status !== "sending"; i++) await new Promise((r) => setTimeout(r, 10));

    await env.t.admin.updateTable("notifications").set({ locked_until: sql<Date>`now() - interval '1 second'` }).execute();
    await env.delivery.reconcile(); // reclaimed
    await env.drain(); // a healthy worker sends it (attempt 2)
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "sent", attempt_count: 2 });

    release();
    expect(await frozen).toMatchObject({ claimed: 1, sent: 0 }); // the zombie's completion was refused
    const [after] = await env.notifications(assignmentId);
    expect(after).toMatchObject({ status: "sent", attempt_count: 2 });
    expect(after!.provider_message_id).not.toBe("SM_FROZEN");
    expect((await env.attempts(after!.id)).map((a) => [a.attempt_no, a.outcome])).toEqual([[1, "abandoned"], [2, "accepted"]]);
  });

  it("the worker's pump starts notifications without waiting for them, bounded by its slots: a hung business holds one slot, not the queue", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    for (let i = 0; i < 5; i++) await env.assign(client);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    env.sms.queue(async () => (await gate, { outcome: "accepted", providerMessageId: "SMhung1" }), async () => (await gate, { outcome: "accepted", providerMessageId: "SMhung2" }));

    const { createDeliveryService } = await import("../../src/modules/delivery");
    const pino = (await import("pino")).default;
    const pumped = createDeliveryService({ db: env.t.db, logger: pino({ level: "silent" }), senders: { email: env.email, sms: env.sms }, config: { brandName: "B", leaseSeconds: 60, sendTimeoutMs: 5_000, batchSize: 5, maxInFlight: 3 } });
    expect(await pumped.pump()).toBe(3); // started three; two calls are hanging
    expect(await pumped.pump()).toBe(0); // no free slot: it does not claim what it cannot start
    for (let i = 0; i < 100 && env.sms.calls.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 100 && (await env.t.admin.selectFrom("notifications").select("id").where("status", "=", "sent").execute()).length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await env.t.admin.selectFrom("notifications").select("id").where("status", "=", "sent").execute()).length).toBe(1); // the third, unscripted, went straight through
    expect((await env.t.admin.selectFrom("notifications").select("id").where("status", "=", "pending").execute()).length).toBe(2); // the rest wait, unclaimed

    release();
    await pumped.settled();
    expect(await pumped.pump()).toBe(2);
    await pumped.settled();
    expect((await env.t.admin.selectFrom("notifications").select("status").execute()).every((row) => row.status === "sent")).toBe(true);
  });

  it("a live lease is left alone by the reconciler", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    const [row] = await env.notifications(assignmentId);
    await env.t.admin.updateTable("notifications").set({ status: "sending", attempt_count: 1, locked_until: sql<Date>`now() + interval '30 seconds'` }).where("id", "=", row!.id).execute();
    expect(await env.delivery.reconcile()).toMatchObject({ requeued: 0, dead: 0 });
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "sending", attempt_count: 1 });
    expect(await env.attempts(row!.id)).toHaveLength(0);
  });

  it("a worker frozen on attempt 1 cannot complete once attempt 2 holds the notification (even though it is 'sending' again)", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    const gates: Array<() => void> = [];
    const hang = (sid: string) => async () => (await new Promise<void>((resolve) => gates.push(resolve)), { outcome: "accepted" as const, providerMessageId: sid });
    env.sms.queue(hang("SM_FIRST"), hang("SM_SECOND"));

    const first = env.delivery.processDue();
    for (let i = 0; i < 100 && env.sms.calls.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    await env.t.admin.updateTable("notifications").set({ locked_until: sql<Date>`now() - interval '1 second'` }).execute();
    await env.delivery.reconcile();
    const second = env.delivery.processDue(); // attempt 2 is now in flight, 'sending' again
    for (let i = 0; i < 100 && env.sms.calls.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "sending", attempt_count: 2 });

    gates[0]!(); // the zombie answers first: it must be refused
    expect(await first).toMatchObject({ sent: 0 });
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "sending", attempt_count: 2, provider_message_id: null });

    gates[1]!();
    expect(await second).toMatchObject({ sent: 1 });
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "sent", provider_message_id: "SM_SECOND" });
  });

  it("six workers draining 30 assignments over two channels send every notification exactly once", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    for (let i = 0; i < 30; i++) await env.assign(client);
    const { createDb } = await import("../../src/lib/db/client");
    const pools = Array.from({ length: 6 }, () => createDb({ url: env.t.appUrl, poolMax: 3 }));
    try {
      await Promise.all(pools.map((db) => env.drain(env.make(db))));
    } finally {
      await Promise.all(pools.map((db) => db.destroy()));
    }
    expect(env.email.calls).toHaveLength(30);
    expect(env.sms.calls).toHaveLength(30);
    expect(new Set(env.sms.calls.map((call) => call.notificationId)).size).toBe(30);
    const rows = await env.t.admin.selectFrom("notifications").select("status").execute();
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["sent"]));
    const assignments = await env.t.admin.selectFrom("lead_assignments").select("status").execute();
    expect(new Set(assignments.map((row) => row.status))).toEqual(new Set(["notified"]));
  }, 60_000);
});

describe("when the assignment or the consent changes first", () => {
  it("taking the lead back before anything is sent cancels the notifications and sends nothing", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    const { assignmentId } = await env.assign(client);
    expect(await env.s.assignments.cancel({ operator: env.staff, assignmentId, reason: "client_declined", requestId: env.s.rid() })).toEqual({ ok: true });
    expect((await env.notifications(assignmentId)).map((n) => n.status)).toEqual(["cancelled", "cancelled"]);
    expect(await env.drain()).toMatchObject({ claimed: 0 });
    expect(env.email.calls).toHaveLength(0);
    expect(env.sms.calls).toHaveLength(0);
  });

  it("a notification already claimed when the lead is taken back is cancelled at send time, not sent", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    await env.t.admin.updateTable("notifications").set({ status: "sending", attempt_count: 1, locked_until: sql<Date>`now() + interval '1 minute'` }).execute();
    await env.s.assignments.cancel({ operator: env.staff, assignmentId, reason: "no_response", requestId: env.s.rid() }); // 'sending' is not touched by the trigger
    await sql`update notifications set locked_until = now() - interval '1 second'`.execute(env.t.admin);
    await env.delivery.reconcile();
    await env.drain();
    expect(env.sms.calls).toHaveLength(0);
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "cancelled", last_error_code: "assignment_ended" });
  });

  it("the send-time checks hold even when the assignment is still active: consent withdrawn, or the lead erased, are not sent", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const withdrawn = await env.assign(client);
    const consent = await env.t.admin.selectFrom("consent_records").select("consent_text_id").where("lead_id", "=", withdrawn.leadId).executeTakeFirstOrThrow();
    await env.t.admin.insertInto("consent_records").values({ lead_id: withdrawn.leadId, consent_text_id: consent.consent_text_id, event: "withdrawn", method: "operator_request" }).execute();
    const erased = await env.assign(client);
    await env.t.admin.updateTable("leads").set({ erased_at: sql<Date>`now()` }).where("id", "=", erased.leadId).execute();

    await env.drain();
    expect(env.sms.calls).toHaveLength(0);
    const reasons = [...(await env.notifications(withdrawn.assignmentId)), ...(await env.notifications(erased.assignmentId))].map((n) => [n.status, n.last_error_code]);
    expect(reasons).toEqual([["cancelled", "consent_withdrawn"], ["cancelled", "lead_erased"]]);
  });

  it("withdrawing consent cancels what has not been sent, and an erased lead is never sent", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    const withdrawn = await env.assign(client);
    await env.s.privacy.withdrawConsent({ operator: env.staff, leadId: withdrawn.leadId, requestId: env.s.rid() });
    expect((await env.notifications(withdrawn.assignmentId)).map((n) => n.status)).toEqual(["cancelled", "cancelled"]);

    const erased = await env.assign(client);
    await env.t.admin.updateTable("notifications").set({ status: "sending", attempt_count: 1, locked_until: sql<Date>`now() + interval '1 minute'` }).where("assignment_id", "=", erased.assignmentId).execute();
    expect(await env.s.privacy.erase({ operator: env.owner, leadId: erased.leadId, reason: "test_data", requestId: env.s.rid() })).toMatchObject({ ok: true });
    await sql`update notifications set locked_until = now() - interval '1 second' where assignment_id = ${erased.assignmentId}`.execute(env.t.admin);
    await env.delivery.reconcile();
    await env.drain();
    expect(env.email.calls).toHaveLength(0);
    expect(env.sms.calls).toHaveLength(0);
  });
});

describe("secrets and personal data", () => {
  it("a webhook with an unreadable secret (wrong key) is retried and reported, never sent unsigned and never given up", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, webhook: true });
    const { assignmentId } = await env.assign(client);
    const { randomBytes } = await import("node:crypto");
    const { createDeliveryService } = await import("../../src/modules/delivery");
    const pino = (await import("pino")).default;
    const wrongKey = createDeliveryService({ db: env.t.db, logger: pino({ level: "silent" }), senders: { email: env.email, webhook: env.webhook }, config: { brandName: "B", leaseSeconds: 60, sendTimeoutMs: 1_000, batchSize: 5, secretsKey: randomBytes(32) } });
    await env.drain(wrongKey);
    expect(env.webhook.calls).toHaveLength(0);
    expect((await env.notifications(assignmentId))[0]).toMatchObject({ status: "retrying", last_error_code: "secret_unreadable" });
  });

  it("no personal data in a notification, an attempt, a provider event, the history, the audit trail or the logs, even on failure", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    const lead = await insertRawLead(env.t.admin, { email: "distinctive.person@example.org", phone: "+447911555123" });
    await env.t.admin.updateTable("lead_contacts").set({ full_name: "Distinctive Personname", notes: "Distinctive note 9876" }).where("lead_id", "=", lead.id).execute();
    const { assignmentId } = await env.assign(client, env.staff, lead);
    env.sms.queue(permanent("twilio_21211"));
    await env.drain();
    await env.delivery.applyProviderEvent({ provider: "twilio", eventId: "SMx:undelivered", sid: "SMx", status: "undelivered", errorCode: "30003" });

    const dump = JSON.stringify([
      await env.notifications(assignmentId), await env.t.admin.selectFrom("notification_attempts").selectAll().execute(), await env.t.admin.selectFrom("provider_events").selectAll().execute(),
      await env.t.admin.selectFrom("lead_assignment_status_history").selectAll().execute(), await env.t.admin.selectFrom("audit_logs").selectAll().execute(),
      await env.t.admin.selectFrom("lead_events").selectAll().where("lead_id", "=", lead.id).execute(),
    ]);
    for (const secret of ["distinctive.person", "Distinctive", "447911555123", "9876"]) expect(dump).not.toContain(secret);
  });
});
