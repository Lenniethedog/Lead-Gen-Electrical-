import { sql } from "kysely";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { getDeliveryHealth } from "../../src/modules/delivery";
import { createPipelineHandler } from "../../src/server/handlers/pipeline";
import { buildDelivery, permanent, type DeliveryEnv } from "../helpers/delivery";

/** Provider callbacks, the operator's "try again", and what /api/pipeline says about delivery. */
let env: DeliveryEnv;
afterEach(async () => {
  await env?.destroy();
});

const SID = "SM11111111111111111111111111111111";

/** An SMS-only business with one lead sent (the provider accepted it as `SID`). */
async function sentSms(options: { email?: boolean } = {}) {
  env = await buildDelivery();
  const client = await env.automaticClient(env.owner, { email: options.email ?? false, sms: true });
  const { assignmentId, leadId } = await env.assign(client);
  env.sms.queue({ outcome: "accepted", providerMessageId: SID });
  await env.drain();
  const sms = (await env.notifications(assignmentId)).find((row) => row.channel === "sms")!;
  return { client, assignmentId, leadId, sms };
}
const callback = (status: string, errorCode: string | null = null, sid = SID) => env.delivery.applyProviderEvent({ provider: "twilio", eventId: `${sid}:${status}`, sid, status, errorCode });
const row = (id: string) => env.t.admin.selectFrom("notifications").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

describe("delivery reports from the provider", () => {
  it("a delivered report marks the text delivered, once; repeating it changes nothing", async () => {
    const { sms } = await sentSms();
    expect(await callback("queued")).toBe("ignored");
    expect(await callback("sent")).toBe("ignored");
    expect(await callback("delivered")).toBe("applied");
    expect(await row(sms.id)).toMatchObject({ status: "delivered" });
    expect((await row(sms.id)).delivered_at).not.toBeNull();
    expect(await callback("delivered")).toBe("duplicate");
    expect(await env.t.admin.selectFrom("provider_events").select("id").where("event_id", "=", `${SID}:delivered`).execute()).toHaveLength(1);
  });

  it("an undelivered report marks the text failed with the provider's code; if an email did go out the assignment stays notified, and the failure is queued for a person", async () => {
    const { sms, assignmentId } = await sentSms({ email: true });
    expect(await callback("undelivered", "30003")).toBe("applied");
    expect(await row(sms.id)).toMatchObject({ status: "failed", last_error_code: "twilio_30003" });
    expect(await env.assignmentRow(assignmentId)).toMatchObject({ status: "notified" });
    expect((await env.delivery.problems()).map((problem) => [problem.id, problem.channel, problem.lastErrorCode])).toEqual([[sms.id, "sms", "twilio_30003"]]);
    expect((await getDeliveryHealth(env.t.db)).problems).toEqual(["deliveries_failing"]);
  });

  it("reports out of order or after the fact never move a notification backwards", async () => {
    const { sms } = await sentSms();
    await callback("delivered");
    expect(await callback("undelivered", "30006")).toBe("applied"); // recorded, but...
    expect(await row(sms.id)).toMatchObject({ status: "delivered", last_error_code: null }); // ...a delivered text stays delivered
    expect(await callback("failed", "30008", "SM_unknown_" + "0".repeat(21))).toBe("unmatched");
  });

  it("a delivered report cannot resurrect a notification that already failed", async () => {
    const { sms } = await sentSms({ email: true });
    await callback("undelivered", "30003");
    expect(await row(sms.id)).toMatchObject({ status: "failed" });
    expect(await callback("delivered")).toBe("applied"); // recorded...
    expect(await row(sms.id)).toMatchObject({ status: "failed", delivered_at: null }); // ...but a failed text stays failed
  });

  it("a report that arrives BEFORE we recorded the message id is kept and applied by the reconciler", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    expect(await callback("delivered")).toBe("unmatched");
    const [pending] = await env.notifications(assignmentId);
    await env.t.admin.updateTable("notifications").set({ status: "sent", sent_at: sql<Date>`now()`, provider_message_id: SID, attempt_count: 1 }).where("id", "=", pending!.id).execute();
    await env.t.admin.updateTable("provider_events").set({ received_at: sql<Date>`now() - interval '1 minute'` }).execute();
    expect(await env.delivery.reconcile()).toMatchObject({ eventsApplied: 1 });
    expect(await row(pending!.id)).toMatchObject({ status: "delivered" });
    expect((await env.t.admin.selectFrom("provider_events").select("processed_at").executeTakeFirstOrThrow()).processed_at).not.toBeNull();
  });

  it("ten identical reports at once are applied exactly once", async () => {
    const { sms } = await sentSms();
    const results = await Promise.all(Array.from({ length: 10 }, () => callback("delivered")));
    expect(results.filter((result) => result === "applied")).toHaveLength(1);
    expect(results.filter((result) => result === "duplicate")).toHaveLength(9);
    expect(await row(sms.id)).toMatchObject({ status: "delivered" });
  });

  it("a webhook that gives up marks the business's webhook as failing, and a success clears it", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, webhook: true });
    const first = await env.assign(client);
    env.webhook.queue(permanent("http_410"));
    await env.drain();
    expect((await env.clients.deliverySettings(client))!.failingSince).not.toBeNull();
    expect(await env.assignmentRow(first.assignmentId)).toMatchObject({ status: "delivery_failed" });
    await env.assign(client);
    await env.drain(); // the next one succeeds
    expect((await env.clients.deliverySettings(client))!.failingSince).toBeNull();
  });

  it("keeps only the status and error code of a report (the provider's own body, with phone numbers, is never stored)", async () => {
    await sentSms();
    await callback("delivered");
    const [event] = await env.t.admin.selectFrom("provider_events").selectAll().execute();
    expect(Object.keys(event!).sort()).toEqual(["error_code", "event_id", "id", "processed_at", "provider", "provider_message_id", "received_at", "status"]);
  });
});

describe("a person trying again", () => {
  it("puts a failed notification back in the queue, and it is sent; the retry is audited", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true, sms: true });
    const { assignmentId } = await env.assign(client);
    env.sms.queue(permanent("twilio_21211"));
    await env.drain();
    const sms = (await env.notifications(assignmentId)).find((n) => n.channel === "sms")!;
    expect(sms.status).toBe("failed");

    expect(await env.delivery.retry({ operator: env.staff, notificationId: sms.id, requestId: env.s.rid() })).toEqual({ ok: true });
    expect(await row(sms.id)).toMatchObject({ status: "pending", attempt_count: 0, last_error_code: null });
    await env.drain();
    expect(await row(sms.id)).toMatchObject({ status: "sent", attempt_count: 1 });
    const audit = await env.t.admin.selectFrom("audit_logs").select(["action", "actor_id", "entity_id"]).where("action", "=", "delivery.retried").execute();
    expect(audit).toEqual([{ action: "delivery.retried", actor_id: env.staff.id, entity_id: sms.id }]);
    expect((await getDeliveryHealth(env.t.db)).problems).toEqual([]);
  });

  it("refuses to retry something that is not failed, that does not exist, or whose assignment has ended", async () => {
    const { sms, assignmentId } = await sentSms({ email: true });
    expect(await env.delivery.retry({ operator: env.staff, notificationId: sms.id, requestId: env.s.rid() })).toEqual({ ok: false, code: "not_retryable" });
    expect(await env.delivery.retry({ operator: env.staff, notificationId: "00000000-0000-4000-8000-000000000000", requestId: env.s.rid() })).toEqual({ ok: false, code: "not_found" });
    await callback("undelivered", "30003");
    await env.s.assignments.cancel({ operator: env.staff, assignmentId, reason: "client_unavailable", requestId: env.s.rid() });
    expect(await env.delivery.retry({ operator: env.staff, notificationId: sms.id, requestId: env.s.rid() })).toEqual({ ok: false, code: "assignment_ended" });
  });
});

describe("what /api/pipeline says about delivery", () => {
  it("is healthy when idle, flags an overdue notification, and clears when it is sent", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    expect((await getDeliveryHealth(env.t.db)).problems).toEqual([]); // just created: due now, fine
    const [n] = await env.notifications(assignmentId);
    await env.t.admin.updateTable("notifications").set({ next_attempt_at: sql<Date>`now() - interval '3 minutes'` }).where("id", "=", n!.id).execute();
    expect((await getDeliveryHealth(env.t.db)).problems).toEqual(["deliveries_overdue"]);
    await env.drain();
    expect((await getDeliveryHealth(env.t.db)).problems).toEqual([]);
  });

  it("flags an automatic assignment that has no notification at all (the enqueue path is broken), but not one made before automatic delivery was switched on", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: true });
    const { assignmentId } = await env.assign(client);
    await env.t.admin.deleteFrom("notifications").where("assignment_id", "=", assignmentId).execute();
    await env.t.admin.updateTable("lead_assignments").set({ created_at: sql<Date>`now() - interval '5 minutes'` }).where("id", "=", assignmentId).execute();
    await env.t.admin.updateTable("clients").set({ delivery_enabled_at: sql<Date>`now() - interval '1 hour'` }).where("id", "=", client).execute();
    expect((await getDeliveryHealth(env.t.db)).problems).toEqual(["deliveries_missing"]);
    await env.t.admin.updateTable("clients").set({ delivery_enabled_at: sql<Date>`now()` }).where("id", "=", client).execute();
    expect((await getDeliveryHealth(env.t.db)).problems).toEqual([]);
  });

  it("is reported by the endpoint as a code only", async () => {
    env = await buildDelivery();
    const client = await env.automaticClient(env.owner, { email: false, sms: true });
    const { assignmentId } = await env.assign(client);
    await env.t.admin.updateTable("notifications").set({ next_attempt_at: sql<Date>`now() - interval '3 minutes'` }).where("assignment_id", "=", assignmentId).execute();
    await sql`insert into worker_heartbeats (worker_id) values ('w') on conflict (worker_id) do update set last_beat_at = now()`.execute(env.t.admin);
    const response = await createPipelineHandler({ db: env.t.db, logger: pino({ level: "silent" }), ttlMs: 0 })();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "degraded", problems: expect.arrayContaining(["deliveries_overdue"]) });
  });
});
