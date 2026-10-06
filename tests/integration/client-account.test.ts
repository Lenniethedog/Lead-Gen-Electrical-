import { sql } from "kysely";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClientScope } from "../../src/lib/db/client-scope";
import type { ClientSession } from "../../src/modules/clientauth";
import { createPortalService } from "../../src/modules/portal";
import { buildRouting, type RoutingEnv } from "../helpers/routing";
import { insertRawLead } from "../helpers/raw";

/**
 * What a business controls about its own account (stage 6, slice 5): how it is told (the sensitive part is WHERE leads go), a read-only view
 * of what it covers with a way to ask for changes, and counts of how it is doing. What must hold: roles are enforced in the service, a
 * business can change only the columns it is meant to, coverage is read-only to it even at the database, and the numbers are exactly right.
 */
let env: RoutingEnv;
let portal: ReturnType<typeof createPortalService>;
let aId: string;
let bId: string;
let owner: ClientSession;
let manager: ClientSession;
let agent: ClientSession;
let other: ClientSession;

const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;
const silent = pino({ level: "silent" });

async function person(clientId: string, role: ClientSession["role"]): Promise<ClientSession> {
  const row = await env.t.admin.insertInto("client_users").values({ client_id: clientId, email: `p-${crypto.randomUUID().slice(0, 8)}@x.example`, name: `${role} person`, role }).returning("id").executeTakeFirstOrThrow();
  return { sessionId: crypto.randomUUID(), userId: row.id, clientId, clientName: "Biz", name: `${role} person`, email: "p@x.example", role };
}

beforeAll(async () => {
  env = await buildRouting({ price: 3500 });
  portal = createPortalService({ db: env.t.db, logger: silent, assignments: env.s.assignments });
  aId = await env.s.activeClient(env.owner, { name: "Account A", outward: ["BR6", "BR5"] });
  bId = await env.s.activeClient(env.owner, { name: "Account B", outward: ["TN13"] });
  owner = await person(aId, "owner");
  manager = await person(aId, "manager");
  agent = await person(aId, "agent");
  other = await person(bId, "owner");
});
afterAll(async () => {
  await env.destroy();
});

const clientRow = (id: string) => env.t.admin.selectFrom("clients").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const settings = (over: Record<string, string> = {}) => ({ contactEmail: "new-leads@electrician.example", contactPhone: "07911 123456", notifyEmail: "on", notifySms: "on", ...over });

describe("how the business is told", () => {
  it("an owner changes where leads go and which ways are on, and it is audited with who and what", async () => {
    const before = await clientRow(aId);
    expect(await portal.saveNotificationSettings(owner, settings(), rid())).toEqual({ ok: true });
    const after = await clientRow(aId);
    expect(after).toMatchObject({ contact_email: "new-leads@electrician.example", contact_phone_e164: "+447911123456", notify_email: true, notify_sms: true });
    expect(before.contact_email).not.toBe(after.contact_email);
    const entry = await env.t.admin.selectFrom("audit_logs").selectAll().where("action", "=", "client.notification_settings_changed").where("entity_id", "=", aId).orderBy("id", "desc").executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ actor_type: "client_user", actor_id: owner.userId, after: { contact_email: "new-leads@electrician.example", notify_sms: true, contact_phone_set: true, address_changed: true } });
    expect(JSON.stringify(entry)).not.toContain("07911"); // the number itself is not copied into the trail
  });

  it("a manager can switch email and text on or off but NOT change where leads are sent", async () => {
    const current = await clientRow(aId);
    expect(await portal.saveNotificationSettings(manager, settings({ contactEmail: current.contact_email, contactPhone: "07911 123456", notifySms: "" }), rid())).toEqual({ ok: true });
    expect((await clientRow(aId)).notify_sms).toBe(false);
    expect(await portal.saveNotificationSettings(manager, settings({ contactEmail: "attacker@evil.example", notifySms: "" }), rid())).toEqual({ ok: false, code: "forbidden" });
    expect(await portal.saveNotificationSettings(manager, settings({ contactEmail: current.contact_email, contactPhone: "07911 100002", notifySms: "" }), rid())).toEqual({ ok: false, code: "forbidden" });
    expect((await clientRow(aId)).contact_email).toBe(current.contact_email);
  });

  it("an agent cannot change anything", async () => {
    const before = await clientRow(aId);
    expect(await portal.saveNotificationSettings(agent, settings({ notifyEmail: "" }), rid())).toEqual({ ok: false, code: "forbidden" });
    expect(await clientRow(aId)).toEqual(before);
  });

  it("checks the address and number, and a text needs a number", async () => {
    const cases: Array<[Record<string, string>, string]> = [
      [settings({ contactEmail: "not-an-email" }), "contactEmail"], [settings({ contactEmail: "" }), "contactEmail"], [settings({ contactPhone: "12345" }), "contactPhone"], [settings({ contactPhone: "", notifySms: "on" }), "contactPhone"],
    ];
    for (const [fields, field] of cases) {
      const result = await portal.saveNotificationSettings(owner, fields, rid());
      expect(result, JSON.stringify(fields)).toMatchObject({ ok: false, code: "invalid" });
      expect(Object.keys((result as { errors?: object }).errors ?? {}), JSON.stringify(fields)).toEqual([field]); // the page says WHICH field is wrong
    }
    expect(await portal.saveNotificationSettings(owner, settings({ contactPhone: "", notifySms: "" }), rid())).toEqual({ ok: true });
    expect((await clientRow(aId)).contact_phone_e164).toBeNull();
  });

  it("a business on automatic delivery must keep at least one way on", async () => {
    await env.t.admin.updateTable("clients").set({ delivery_mode: "automatic", delivery_enabled_at: new Date(), notify_webhook: false }).where("id", "=", aId).execute();
    expect(await portal.saveNotificationSettings(owner, settings({ contactPhone: "", notifyEmail: "", notifySms: "" }), rid())).toEqual({ ok: false, code: "no_channel" });
    expect((await clientRow(aId)).notify_email).toBe(true);
    // ...but with the staff-managed webhook on, turning both of its own off is allowed.
    await env.t.admin.updateTable("clients").set({ notify_webhook: true, webhook_url: "https://crm.example.com/hook", webhook_secret_enc: "v1:test", webhook_secret_hint: "test" }).where("id", "=", aId).execute();
    expect(await portal.saveNotificationSettings(owner, settings({ contactPhone: "", notifyEmail: "", notifySms: "" }), rid())).toEqual({ ok: true });
    await env.t.admin.updateTable("clients").set({ delivery_mode: "manual", delivery_enabled_at: null, notify_webhook: false, webhook_url: null, webhook_secret_enc: null, webhook_secret_hint: null, notify_email: true }).where("id", "=", aId).execute();
  });

  it("saying nothing new is not a change (and writes no audit entry)", async () => {
    const state = await clientRow(aId);
    const fields = { contactEmail: state.contact_email, contactPhone: state.contact_phone_e164 ?? "", notifyEmail: state.notify_email ? "on" : "", notifySms: state.notify_sms ? "on" : "" };
    const audits = (await env.t.admin.selectFrom("audit_logs").select("id").where("action", "=", "client.notification_settings_changed").execute()).length;
    expect(await portal.saveNotificationSettings(owner, fields, rid())).toEqual({ ok: false, code: "unchanged" });
    expect((await env.t.admin.selectFrom("audit_logs").select("id").where("action", "=", "client.notification_settings_changed").execute()).length).toBe(audits);
  });

  it("changes ONLY those four columns, whatever else is posted", async () => {
    const before = await clientRow(aId);
    const result = await portal.saveNotificationSettings(owner, { ...settings({ contactEmail: "only-this@electrician.example" }), name: "Hijacked", status: "suspended", deliveryMode: "automatic", billingMode: "prepaid", weight: "99", priority: "0", webhookUrl: "https://evil.example/x", maxOpenLeads: "1", daily_lead_cap: "1" }, rid());
    expect(result).toEqual({ ok: true });
    const after = await clientRow(aId);
    for (const column of ["name", "status", "delivery_mode", "billing_mode", "weight", "priority", "webhook_url", "max_open_leads", "daily_lead_cap", "notify_webhook", "contact_name"] as const) {
      expect(after[column], column).toEqual(before[column]);
    }
    // Fixed values as well, not just "same as before": an earlier change to these (by a bug) must not be able to hide itself.
    expect(after).toMatchObject({ name: "Account A", status: "active", delivery_mode: "manual", billing_mode: "invoice", weight: 1, priority: 100, webhook_url: null, max_open_leads: null, daily_lead_cap: null, notify_webhook: false });
    expect(after.contact_email).toBe("only-this@electrician.example");
  });

  it("works on the signed-in business only: another business's settings are untouched", async () => {
    const theirs = await clientRow(bId);
    await portal.saveNotificationSettings(owner, settings({ contactEmail: "mine@electrician.example" }), rid());
    expect(await clientRow(bId)).toEqual(theirs);
    expect((await portal.notificationSettings(other))?.contactEmail).toBe(theirs.contact_email);
  });
});

describe("where and what the business covers", () => {
  it("shows its own services and coverage in words, never another business's", async () => {
    const view = await portal.serviceAreas(owner);
    expect(view.services).toEqual(["Electrical fault or repair"]);
    expect(view.rules.map((r) => r.description).sort()).toEqual(["Postcode district BR5", "Postcode district BR6"]);
    expect(view.rules.every((r) => r.mode === "include")).toBe(true);
    expect((await portal.serviceAreas(other)).rules.map((r) => r.description)).toEqual(["Postcode district TN13"]);
  });

  it("is read-only for a business, at the database: it cannot add, change or remove coverage or services", async () => {
    const insert = withClientScope(env.t.db, aId, (scoped) => sql`insert into client_service_areas (client_id, mode, kind, outward) values (${aId}, 'include', 'outward', 'BR1')`.execute(scoped));
    await expect(insert).rejects.toThrow(/row-level security/);
    // (The application role has no UPDATE right on coverage at all: staff add and remove rules, they do not edit them.)
    await expect(withClientScope(env.t.db, aId, (scoped) => sql`update client_service_areas set mode = 'exclude' where client_id = ${aId}`.execute(scoped))).rejects.toThrow(/permission denied/);
    const removed = await withClientScope(env.t.db, aId, (scoped) => sql`delete from client_service_areas where client_id = ${aId}`.execute(scoped));
    expect(Number(removed.numAffectedRows)).toBe(0);
    const services = await withClientScope(env.t.db, aId, (scoped) => sql`delete from client_services where client_id = ${aId}`.execute(scoped));
    expect(Number(services.numAffectedRows)).toBe(0);
    expect((await portal.serviceAreas(owner)).rules).toHaveLength(2);
  });

  it("a raw read of coverage is still limited to the business", async () => {
    const seen = await withClientScope(env.t.db, aId, (scoped) => sql<{ client_id: string }>`select client_id from client_service_areas`.execute(scoped));
    expect(new Set(seen.rows.map((r) => r.client_id))).toEqual(new Set([aId]));
    const services = await withClientScope(env.t.db, aId, (scoped) => sql<{ client_id: string }>`select client_id from client_services`.execute(scoped));
    expect(new Set(services.rows.map((r) => r.client_id))).toEqual(new Set([aId]));
  });
});

describe("asking for a change", () => {
  it("an owner or manager can ask; an agent cannot; the request is audited and visible to staff", async () => {
    expect(await portal.requestChange(agent, { kind: "coverage", message: "Please add BR1 and BR2" }, rid())).toEqual({ ok: false, code: "forbidden" });
    expect(await portal.requestChange(owner, { kind: "coverage", message: "Please add BR1 and BR2" }, rid())).toEqual({ ok: true });
    expect(await portal.requestChange(manager, { kind: "services", message: "We now do EV chargers too" }, rid())).toEqual({ ok: true });
    const mine = await portal.myChangeRequests(owner);
    expect(mine.map((r) => r.message)).toEqual(["We now do EV chargers too", "Please add BR1 and BR2"]);
    expect((await portal.myChangeRequests(other))).toEqual([]);
    const open = await portal.openChangeRequests(aId);
    expect(open.map((r) => r.message)).toEqual(["Please add BR1 and BR2", "We now do EV chargers too"]); // oldest first for staff
    expect(open[0]).toMatchObject({ clientName: "Account A", kind: "coverage", status: "open" });
    expect(await env.t.admin.selectFrom("audit_logs").select("id").where("action", "=", "client.change_requested").where("entity_id", "=", aId).execute()).toHaveLength(2);
  });

  it("checks what was typed", async () => {
    for (const fields of [{}, { kind: "everything", message: "something long enough" }, { kind: "other", message: "no" }, { kind: "other", message: "x".repeat(1001) }]) {
      expect(await portal.requestChange(owner, fields as Record<string, string>, rid()), JSON.stringify(fields)).toMatchObject({ ok: false, code: "invalid" });
    }
  });

  it("allows at most five open at once, even when ten arrive together", async () => {
    const busy = await person(bId, "owner");
    const results = await Promise.all(Array.from({ length: 10 }, (_, n) => portal.requestChange(busy, { kind: "other", message: `Request number ${n} please` }, rid())));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.code === "too_many")).toHaveLength(5);
    expect((await env.t.admin.selectFrom("client_change_requests").select("id").where("client_id", "=", bId).execute())).toHaveLength(5);
  });

  it("staff mark one done, once, and it is audited; a business cannot mark its own done", async () => {
    const [first] = await portal.openChangeRequests(aId);
    expect(await portal.markChangeRequestDone({ operator: env.owner, requestId: first!.id, requestRef: rid() })).toEqual({ ok: true, clientId: aId });
    expect(await portal.markChangeRequestDone({ operator: env.owner, requestId: first!.id, requestRef: rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await portal.markChangeRequestDone({ operator: env.owner, requestId: "nope", requestRef: rid() })).toEqual({ ok: false, code: "not_found" });
    expect((await portal.openChangeRequests(aId)).map((r) => r.id)).not.toContain(first!.id);
    expect((await portal.myChangeRequests(owner)).find((r) => r.id === first!.id)?.status).toBe("done");
    expect(await env.t.admin.selectFrom("audit_logs").select(["actor_id"]).where("action", "=", "client.change_request_done").where("entity_id", "=", aId).executeTakeFirstOrThrow()).toEqual({ actor_id: env.owner.id });
    // The table's own rule: done needs a named member of staff and a time.
    await expect(env.t.admin.updateTable("client_change_requests").set({ status: "done" }).where("client_id", "=", bId).execute()).rejects.toMatchObject({ code: "23514" });
    const seen = await withClientScope(env.t.db, aId, (scoped) => sql<{ client_id: string }>`select client_id from client_change_requests`.execute(scoped));
    expect(new Set(seen.rows.map((r) => r.client_id))).toEqual(new Set([aId]));
  });
});

describe("how the business is doing", () => {
  /** A business with a precisely known history, so every number below can be checked by hand. */
  async function history() {
    const id = await env.s.activeClient(env.owner, { name: "Counted" });
    const mgr = await person(id, "owner");
    const lead = async (status: "accepted" | "rejected" | "refunded" | "notified" | "reserved") => {
      const l = await insertRawLead(env.t.admin, {});
      const r = await env.s.assignments.assign({ operator: env.owner, leadId: l.id, clientId: id, requestId: rid() });
      if (!r.ok) throw new Error(r.code);
      return { assignmentId: r.assignmentId, leadId: l.id, status };
    };
    const move = async (assignmentId: string, steps: string[]) => {
      await env.t.admin.transaction().execute(async (trx) => {
        await sql`select set_config('app.actor_type', 'system', true), set_config('app.reason', 'test', true)`.execute(trx);
        for (const step of steps) await sql`update lead_assignments set status = ${step}::assignment_status where id = ${assignmentId}`.execute(trx);
        if (steps.at(-1) === "rejected" || steps.at(-1) === "refunded") await sql`update leads set status = 'new' where id = (select lead_id from lead_assignments where id = ${assignmentId})`.execute(trx);
      });
    };
    const attempt = (assignmentId: string, outcome: string, value: number | null, minutesAfterAccept: number) =>
      sql`insert into assignment_contact_attempts (assignment_id, outcome, job_value_pence, created_by, occurred_at)
          select ${assignmentId}, ${outcome}::contact_outcome, ${value}, ${mgr.userId}, accepted_at + make_interval(mins => ${minutesAfterAccept}) from lead_assignments where id = ${assignmentId}`.execute(env.t.admin);
    const times = (assignmentId: string, respondedAfterMinutes: number, column: "accepted_at" | "rejected_at") =>
      sql`update lead_assignments set notified_at = now() - interval '2 hours', ${sql.ref(column)} = now() - interval '2 hours' + make_interval(mins => ${respondedAfterMinutes}) where id = ${assignmentId}`.execute(env.t.admin);

    // 1: accepted after 10 minutes; first contact 20 minutes later; spoke, quoted £1,800, then WON at £1,500 (the quote was higher than the price won).
    const one = await lead("accepted"); await move(one.assignmentId, ["notified", "accepted"]); await times(one.assignmentId, 10, "accepted_at");
    await attempt(one.assignmentId, "spoke", null, 20); await attempt(one.assignmentId, "quote_sent", 180_000, 40); await attempt(one.assignmentId, "won", 150_000, 60);
    // 2: accepted after 30 minutes; rang, no answer only.
    const two = await lead("accepted"); await move(two.assignmentId, ["notified", "accepted"]); await times(two.assignmentId, 30, "accepted_at"); await attempt(two.assignmentId, "no_answer", null, 40);
    // 3: declined after 50 minutes.
    const three = await lead("rejected"); await move(three.assignmentId, ["notified", "rejected"]); await times(three.assignmentId, 50, "rejected_at");
    // 4: accepted, lost.
    const four = await lead("accepted"); await move(four.assignmentId, ["notified", "accepted"]); await times(four.assignmentId, 20, "accepted_at"); await attempt(four.assignmentId, "lost", null, 60);
    // 5: refunded after a dispute.
    const five = await lead("refunded"); await move(five.assignmentId, ["notified", "disputed", "refunded"]);
    // 6: never told and taken back (not counted at all), 7: still waiting (counted as received only).
    const six = await lead("reserved"); await env.s.assignments.cancel({ operator: env.owner, assignmentId: six.assignmentId, reason: "no_response", requestId: rid() });
    await lead("reserved");
    // 8: an old one, outside a 7-day window but inside 30.
    const old = await lead("accepted"); await move(old.assignmentId, ["notified", "accepted"]); await times(old.assignmentId, 5, "accepted_at"); await sql`update lead_assignments set created_at = now() - interval '20 days' where id = ${old.assignmentId}`.execute(env.t.admin);
    return { id, mgr };
  }

  it("counts exactly what happened, and what it cost", async () => {
    const { mgr } = await history();
    const p = await portal.performance(mgr, 30);
    // received: 1,2,3,4,5,7 and the old one = 7 (the one taken back before being told is not counted)
    expect(p).toMatchObject({ days: 30, received: 7, accepted: 4, declined: 1, contacted: 3, reached: 2, quoted: 1, won: 1, refunded: 1, moneyHidden: false });
    expect(p.wonValuePence).toBe(150_000); // the value of the win, not the earlier quote
    expect(p.spendPence).toBe(3500 * 5); // charged and kept: 1, 2, 4, 7 and the old one (the declined, refunded and taken-back leads were released)
    expect(p.medianResponseMinutes).toBe(20); // answered after 10, 30, 50 (declined), 20 and 5 minutes: the middle one is 20
    expect(p.medianFirstContactMinutes).toBe(40); // first contact 20, 40 and 60 minutes after accepting
  });

  it("looks only at the window asked for", async () => {
    const { mgr } = await history();
    const week = await portal.performance(mgr, 7);
    const month = await portal.performance(mgr, 30);
    expect(week.received).toBe(month.received - 1);
    expect((await portal.performance(mgr, 999)).days).toBe(30); // anything else falls back to 30
  });

  it("an agent gets the counts but not the money (withheld by the service, not just hidden)", async () => {
    const { id } = await history();
    const crew = await person(id, "agent");
    const p = await portal.performance(crew, 30);
    expect(p).toMatchObject({ received: 7, won: 1, moneyHidden: true, wonValuePence: 0, spendPence: 0 });
  });

  it("never includes another business's leads", async () => {
    const { mgr } = await history();
    const mine = await portal.performance(mgr, 30);
    const theirs = await portal.performance(other, 30);
    expect(theirs.received).toBe(0);
    expect(mine.received).toBe(7);
    const empty = await portal.performance(await person(bId, "owner"), 30);
    expect(empty).toMatchObject({ received: 0, won: 0, spendPence: 0, medianResponseMinutes: null, medianFirstContactMinutes: null });
  });
});
