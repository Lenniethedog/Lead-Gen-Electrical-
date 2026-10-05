import { sql } from "kysely";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEAD_EVENT } from "../../src/config/lead-events";
import { createInboxService, ensureOperator, type InboxService, type Operator } from "../../src/modules/inbox";
import { enqueueOperatorAlert } from "../../src/modules/alerts";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawLead } from "../helpers/raw";

let t: TestDatabase;
let inbox: InboxService;
let alice: Operator;
let bob: Operator;

beforeAll(async () => {
  t = await createTestDatabase();
  inbox = createInboxService({ db: t.db, logger: pino({ level: "silent" }) });
  alice = await ensureOperator(t.db, "alice@example.com");
  bob = await ensureOperator(t.db, "bob@example.com");
});
afterAll(async () => {
  await t.destroy();
});

const request = () => `req-${crypto.randomUUID().slice(0, 8)}`;
const heldLead = () => insertRawLead(t.admin, { status: "held", fraudDecision: "review" });
const statusOf = async (id: string) => (await t.admin.selectFrom("leads").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const historyOf = (id: string) => t.admin.selectFrom("lead_status_history").selectAll().where("lead_id", "=", id).orderBy("id").execute();
const eventsOf = (id: string, type?: string) => {
  let query = t.admin.selectFrom("lead_events").selectAll().where("lead_id", "=", id);
  if (type) query = query.where("type", "=", type);
  return query.orderBy("id").execute();
};

describe("operators", () => {
  it("creates the operator on first sight and returns the same id afterwards", async () => {
    const first = await ensureOperator(t.db, "carol@example.com");
    const again = await ensureOperator(t.db, "carol@example.com");
    expect(again).toEqual(first);
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("20 simultaneous first requests from the same new operator converge on ONE row", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, () => ensureOperator(t.db, "dave@example.com")));
    expect(new Set(results.map((operator) => operator.id)).size).toBe(1);
    const rows = await t.admin.selectFrom("operators").select("id").where("email", "=", "dave@example.com").execute();
    expect(rows).toHaveLength(1);
  });

  it("the database refuses an email that is not lowercase", async () => {
    await expect(t.admin.insertInto("operators").values({ email: "Eve@Example.com" }).execute()).rejects.toMatchObject({ code: "23514" });
  });
});

describe("a human decision on a held lead is enforced by the database, not just the code", () => {
  async function tryTransition(context: { actorType?: string; actorId?: string; reason?: string }, to: "new" | "rejected_fraud" | "expired" = "new") {
    const lead = await heldLead();
    const attempt = t.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', ${context.actorType ?? ""}, true), set_config('app.actor_id', ${context.actorId ?? ""}, true), set_config('app.reason', ${context.reason ?? ""}, true)`.execute(trx);
      await trx.updateTable("leads").set({ status: to }).where("id", "=", lead.id).execute();
    });
    return { lead, attempt };
  }

  it("refuses held -> new / rejected_fraud with no actor, a system actor, or no reason", async () => {
    for (const to of ["new", "rejected_fraud"] as const) {
      for (const context of [{}, { actorType: "system", reason: "x" }, { actorType: "staff_user", actorId: alice.id }, { actorType: "staff_user", reason: "genuine" }]) {
        const { lead, attempt } = await tryTransition(context, to);
        await expect(attempt, JSON.stringify(context)).rejects.toMatchObject({ code: "23514" });
        expect(await statusOf(lead.id)).toBe("held");
      }
    }
  });

  it("accepts it with a staff actor, an actor id and a reason, and records them in the history", async () => {
    const { lead, attempt } = await tryTransition({ actorType: "staff_user", actorId: alice.id, reason: "genuine" }, "new");
    await attempt;
    expect(await statusOf(lead.id)).toBe("new");
    expect((await historyOf(lead.id)).at(-1)).toMatchObject({ from_status: "held", to_status: "new", actor_type: "staff_user", actor_id: alice.id, reason: "genuine" });
  });

  it("does not get in the way of an automated transition out of held (e.g. expiry)", async () => {
    const { lead, attempt } = await tryTransition({ actorType: "system" }, "expired");
    await attempt;
    expect(await statusOf(lead.id)).toBe("expired");
  });
});

describe("approving and rejecting held leads", () => {
  it("approve: held -> new, with the operator and a reason code in the history and an event", async () => {
    const lead = await heldLead();
    expect(await inbox.approve({ operator: alice, leadId: lead.id, reason: "verified_contact", requestId: "req-approve-1" })).toEqual({ ok: true });

    expect(await statusOf(lead.id)).toBe("new");
    expect((await historyOf(lead.id)).at(-1)).toMatchObject({
      from_status: "held",
      to_status: "new",
      actor_type: "staff_user",
      actor_id: alice.id,
      reason: "verified_contact",
      request_id: "req-approve-1",
    });
    const [event] = await eventsOf(lead.id, LEAD_EVENT.reviewApproved);
    expect(event).toMatchObject({ actor_type: "staff_user", actor_id: alice.id, request_id: "req-approve-1", payload: { reason: "verified_contact" } });
  });

  it("reject: held -> rejected_fraud, recorded the same way", async () => {
    const lead = await heldLead();
    expect(await inbox.reject({ operator: bob, leadId: lead.id, reason: "spam_or_bot", requestId: request() })).toEqual({ ok: true });
    expect(await statusOf(lead.id)).toBe("rejected_fraud");
    expect((await historyOf(lead.id)).at(-1)).toMatchObject({ from_status: "held", to_status: "rejected_fraud", actor_id: bob.id, reason: "spam_or_bot" });
    expect(await eventsOf(lead.id, LEAD_EVENT.reviewRejected)).toHaveLength(1);
  });

  it("accepts only reason codes of the right kind: free text and the wrong kind of code are refused and change nothing", async () => {
    const lead = await heldLead();
    for (const reason of ["call me on 07911 123456", "", "spam_or_bot"]) {
      expect(await inbox.approve({ operator: alice, leadId: lead.id, reason, requestId: request() })).toEqual({ ok: false, code: "invalid_reason" });
    }
    for (const reason of ["genuine", "Jane Doe", ""]) {
      expect(await inbox.reject({ operator: alice, leadId: lead.id, reason, requestId: request() })).toEqual({ ok: false, code: "invalid_reason" });
    }
    expect(await statusOf(lead.id)).toBe("held");
    expect(await eventsOf(lead.id, LEAD_EVENT.reviewApproved)).toHaveLength(0);
  });

  it("refuses to decide a lead that is not held, or does not exist", async () => {
    const fresh = await insertRawLead(t.admin);
    expect(await inbox.approve({ operator: alice, leadId: fresh.id, reason: "genuine", requestId: request() })).toEqual({ ok: false, code: "not_held" });
    expect(await inbox.reject({ operator: alice, leadId: fresh.id, reason: "spam_or_bot", requestId: request() })).toEqual({ ok: false, code: "not_held" });
    expect(await statusOf(fresh.id)).toBe("new");
    expect(await inbox.approve({ operator: alice, leadId: crypto.randomUUID(), reason: "genuine", requestId: request() })).toEqual({ ok: false, code: "not_found" });
  });

  it("an already-decided lead cannot be flipped by a second decision (no resurrecting a rejected lead)", async () => {
    const lead = await heldLead();
    await inbox.reject({ operator: alice, leadId: lead.id, reason: "spam_or_bot", requestId: request() });
    expect(await inbox.approve({ operator: bob, leadId: lead.id, reason: "genuine", requestId: request() })).toEqual({ ok: false, code: "not_held" });
    expect(await statusOf(lead.id)).toBe("rejected_fraud");
  });

  it("RACE: 5 approvals and 5 rejections of the SAME held lead at once produce exactly one decision", async () => {
    const lead = await heldLead();
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => inbox.approve({ operator: alice, leadId: lead.id, reason: "genuine", requestId: request() })),
      ...Array.from({ length: 5 }, () => inbox.reject({ operator: bob, leadId: lead.id, reason: "spam_or_bot", requestId: request() })),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "not_held")).toHaveLength(9);

    const decisions = (await historyOf(lead.id)).filter((row) => row.actor_type === "staff_user");
    expect(decisions).toHaveLength(1);
    const events = [...(await eventsOf(lead.id, LEAD_EVENT.reviewApproved)), ...(await eventsOf(lead.id, LEAD_EVENT.reviewRejected))];
    expect(events).toHaveLength(1);
    // The recorded decision and the final status agree.
    expect(await statusOf(lead.id)).toBe(decisions[0]!.to_status);
  });

  it("puts no personal data in the history or events it writes", async () => {
    const lead = await heldLead();
    await inbox.approve({ operator: alice, leadId: lead.id, reason: "genuine", requestId: request() });
    const written = JSON.stringify([await historyOf(lead.id), await eventsOf(lead.id)]);
    for (const secret of ["Raw Fixture", "+447911100999", "raw@example.com", "BR6 0AA"]) expect(written).not.toContain(secret);
  });
});

describe("marking a lead handled", () => {
  it("records who handled it and moves it from 'open' to 'handled'", async () => {
    const lead = await insertRawLead(t.admin);
    expect((await inbox.list("open")).rows.map((row) => row.id)).toContain(lead.id);

    expect(await inbox.markHandled({ operator: alice, leadId: lead.id, requestId: "req-handled" })).toEqual({ ok: true });
    const [event] = await eventsOf(lead.id, LEAD_EVENT.handled);
    expect(event).toMatchObject({ actor_type: "staff_user", actor_id: alice.id, request_id: "req-handled" });
    expect((await inbox.list("open")).rows.map((row) => row.id)).not.toContain(lead.id);
    expect((await inbox.list("handled")).rows.map((row) => row.id)).toContain(lead.id);
  });

  it("is idempotent, and 10 simultaneous clicks write exactly one event", async () => {
    const lead = await insertRawLead(t.admin);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => inbox.markHandled({ operator: i % 2 ? alice : bob, leadId: lead.id, requestId: request() })));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && !result.alreadyDone)).toHaveLength(1);
    expect(await eventsOf(lead.id, LEAD_EVENT.handled)).toHaveLength(1);
  });

  it("is not available for held leads (they must be decided) or unknown leads", async () => {
    const held = await heldLead();
    expect(await inbox.markHandled({ operator: alice, leadId: held.id, requestId: request() })).toEqual({ ok: false, code: "not_open" });
    expect(await inbox.markHandled({ operator: alice, leadId: crypto.randomUUID(), requestId: request() })).toEqual({ ok: false, code: "not_found" });
    expect(await eventsOf(held.id, LEAD_EVENT.handled)).toHaveLength(0);
  });
});

describe("listing", () => {
  it("puts each lead in exactly the right view and leaves out test leads", async () => {
    const [held, open, handled, rejected, duplicate, test] = await Promise.all([
      heldLead(),
      insertRawLead(t.admin),
      insertRawLead(t.admin),
      insertRawLead(t.admin, { status: "rejected_fraud", fraudDecision: "reject" }),
      (async () => insertRawLead(t.admin, { status: "duplicate", duplicateOfLeadId: (await insertRawLead(t.admin)).id }))(),
      insertRawLead(t.admin),
    ]);
    await t.admin.updateTable("leads").set({ is_test: true }).where("id", "=", test.id).execute();
    await inbox.markHandled({ operator: alice, leadId: handled.id, requestId: request() });

    const ids = async (view: "open" | "handled" | "screened") => (await inbox.list(view)).rows.map((row) => row.id);
    const [openIds, handledIds, screenedIds] = [await ids("open"), await ids("handled"), await ids("screened")];
    expect(openIds).toEqual(expect.arrayContaining([held.id, open.id]));
    expect(handledIds).toContain(handled.id);
    expect(screenedIds).toEqual(expect.arrayContaining([rejected.id, duplicate.id]));
    for (const id of [held.id, open.id, handled.id, rejected.id, duplicate.id, test.id]) {
      const memberships = [openIds, handledIds, screenedIds].filter((list) => list.includes(id)).length;
      expect(memberships, `lead ${id}`).toBe(id === test.id ? 0 : 1);
    }
  });

  it("a lead nobody could route needs a person; an assigned lead needs one until it has been SENT; handled ones move to Handled", async () => {
    const [unroutable, handledUnroutable, unsent, sent] = await Promise.all([
      insertRawLead(t.admin, { status: "unroutable" }),
      insertRawLead(t.admin, { status: "unroutable" }),
      insertRawLead(t.admin, { status: "assigned" }),
      insertRawLead(t.admin, { status: "assigned" }),
    ]);
    await sql`update lead_assignments set status = 'notified' where lead_id = ${sent.id}`.execute(t.admin); // the operator pressed "I've sent it"
    expect(await inbox.markHandled({ operator: alice, leadId: handledUnroutable.id, requestId: request() })).toEqual({ ok: true });

    const rows = async (view: "open" | "handled" | "assigned") => (await inbox.list(view)).rows;
    const open = await rows("open");
    expect(open.map((row) => row.id)).toEqual(expect.arrayContaining([unroutable.id, unsent.id]));
    expect(open.map((row) => row.id)).not.toContain(sent.id);
    expect(open.map((row) => row.id)).not.toContain(handledUnroutable.id);
    expect(open.find((row) => row.id === unsent.id)).toMatchObject({ status: "assigned", unsent: true });
    expect(open.find((row) => row.id === unroutable.id)).toMatchObject({ status: "unroutable", unsent: false, handled: false });

    expect((await rows("handled")).map((row) => row.id)).toContain(handledUnroutable.id);
    const assigned = await rows("assigned");
    expect(assigned.map((row) => row.id)).toEqual(expect.arrayContaining([unsent.id, sent.id]));
    expect(assigned.find((row) => row.id === sent.id)?.unsent).toBe(false);
  });

  it("explains routing in the timeline: routed, found nobody, and taken back for a person to decide", async () => {
    const lead = await insertRawLead(t.admin);
    for (const [type, payload] of [["lead.routed", { run_id: "r", client_id: "c" }], ["lead.unroutable", { run_id: "r", reason: "no_eligible_client" }], ["lead.routing_stopped", { reason: "quality_issue" }]] as const) {
      await t.admin.insertInto("lead_events").values({ lead_id: lead.id, type, actor_type: "system", payload: JSON.stringify(payload) }).execute();
    }
    const detail = await inbox.detail(lead.id);
    const text = detail!.timeline.map((entry) => entry.text);
    expect(text).toContain("Routed automatically to a business");
    expect(text.some((line) => line.includes("Automatic routing found nobody (no_eligible_client)"))).toBe(true);
    expect(text.some((line) => line.includes("will not be routed automatically") && line.includes("quality_issue"))).toBe(true);
  });

  it("lists every view newest first, so the lead you were just alerted about is at the top", async () => {
    const older = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 20 * 60_000) });
    const newer = await insertRawLead(t.admin, { createdAt: new Date(Date.now() - 5 * 60_000) });
    const open = (await inbox.list("open")).rows.map((row) => row.id);
    expect(open.indexOf(newer.id)).toBeLessThan(open.indexOf(older.id));
    await inbox.markHandled({ operator: alice, leadId: older.id, requestId: request() });
    await inbox.markHandled({ operator: alice, leadId: newer.id, requestId: request() });
    const handled = (await inbox.list("handled")).rows.map((row) => row.id);
    expect(handled.indexOf(newer.id)).toBeLessThan(handled.indexOf(older.id));
  });

  it("shows the alert state, so the operator knows whether the email can be trusted to have gone out", async () => {
    const lead = await insertRawLead(t.admin);
    expect((await inbox.list("open")).rows.find((row) => row.id === lead.id)?.alert).toBe("none");
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    expect((await inbox.list("open")).rows.find((row) => row.id === lead.id)?.alert).toBe("pending");
  });

  it("carries NO personal data in list rows", async () => {
    await insertRawLead(t.admin);
    const json = JSON.stringify(await inbox.list("open"));
    for (const secret of ["Raw Fixture", "+447911100999", "raw@example.com", "BR6 0AA"]) expect(json).not.toContain(secret);
  });

  it("caps a view at 200 rows, keeps the NEWEST, and reports the true total so the page can say what is hidden", async () => {
    const local = await createTestDatabase();
    try {
      const service = createInboxService({ db: local.db, logger: pino({ level: "silent" }) });
      for (let i = 0; i < 205; i += 1) await insertRawLead(local.admin, { createdAt: new Date(Date.now() - (205 - i) * 1_000) });
      const newest = await insertRawLead(local.admin); // arrives last: must be visible whatever the backlog
      const { rows, total, openCount } = await service.list("open");
      expect(rows).toHaveLength(200);
      expect(rows[0]!.id).toBe(newest.id);
      expect(total).toBe(206);
      expect(openCount).toBe(206);
      // The tab badge shows the open count even while another view is selected.
      expect((await service.list("handled")).openCount).toBe(206);
    } finally {
      await local.destroy();
    }
  }, 60_000);
});

describe("lead detail", () => {
  it("returns the contact details, consent, signals, alerts and a timeline naming the operator", async () => {
    const lead = await heldLead();
    await t.admin.insertInto("lead_fraud_signals").values([{ lead_id: lead.id, code: "turnstile_missing", weight: 55 }, { lead_id: lead.id, code: "voip_phone", weight: 15 }]).execute();
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "held" });
    await inbox.approve({ operator: alice, leadId: lead.id, reason: "genuine", requestId: request() });

    const detail = (await inbox.detail(lead.id))!;
    expect(detail).toMatchObject({
      reference: lead.reference,
      status: "new",
      postcode: "BR6 0AA",
      postcodeOutward: "BR6",
      scope: "leak",
      contact: { name: "Raw Fixture", phone: "+447911100999", email: "raw@example.com", notes: null },
    });
    expect(detail.consent?.version).toMatch(/^v\d+$/);
    expect(detail.signals.map((signal) => signal.code)).toEqual(["turnstile_missing", "voip_phone"]);
    expect(detail.alerts).toEqual([expect.objectContaining({ kind: "held_lead", status: "pending", attempts: 0 })]);
    const decision = detail.timeline.find((entry) => entry.text.includes("Held lead approved"));
    expect(decision).toMatchObject({ actor: "alice@example.com", source: "event" });
    expect(detail.timeline.find((entry) => entry.text.startsWith("Status held -> new"))?.actor).toBe("alice@example.com");
    expect(detail.timeline.map((entry) => entry.at.getTime())).toEqual([...detail.timeline.map((entry) => entry.at.getTime())].sort((a, b) => a - b));
  });

  it("returns no contact details for an erased lead, and nothing at all for an unknown or deleted one", async () => {
    const lead = await insertRawLead(t.admin);
    await t.admin
      .updateTable("lead_contacts")
      .set({ full_name: null, phone_e164: null, email: null, email_normalised: null, notes: null, ip: null, user_agent: null, erased_at: new Date() })
      .where("lead_id", "=", lead.id)
      .execute();
    expect((await inbox.detail(lead.id))!.contact).toBeNull();

    expect(await inbox.detail(crypto.randomUUID())).toBeUndefined();
    await t.admin.updateTable("leads").set({ deleted_at: new Date() }).where("id", "=", lead.id).execute();
    expect(await inbox.detail(lead.id)).toBeUndefined();
  });
});
