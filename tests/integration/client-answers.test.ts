import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_DECLINE_REASON_CODES } from "../../src/config/assignment";
import { createPortalService } from "../../src/modules/portal";
import type { ClientSession } from "../../src/modules/clientauth";
import { buildRouting, type RoutingEnv } from "../helpers/routing";
import { insertRawLead } from "../helpers/raw";

/**
 * A business answers the leads it holds (stage 6, slice 2): accept, decline, and record what came of it. What must hold: only the business
 * that holds a lead can answer it; a decline sends the lead to a DIFFERENT business; accept and decline racing leave exactly one outcome;
 * and the database itself refuses a business that tries to end an assignment any other way.
 */
let env: RoutingEnv;
let portal: ReturnType<typeof createPortalService>;
let aId: string;
let bId: string;
let a: ClientSession;
let b: ClientSession;

const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;

function sessionFor(clientId: string, userId: string): ClientSession {
  return { sessionId: crypto.randomUUID(), userId, clientId, clientName: "Biz", name: "Pat", email: "p@x.example", role: "owner" };
}

async function clientUser(clientId: string): Promise<string> {
  const row = await env.t.admin.insertInto("client_users").values({ client_id: clientId, email: `u-${crypto.randomUUID().slice(0, 8)}@x.example`, name: "Pat" }).returning("id").executeTakeFirstOrThrow();
  return row.id;
}

beforeAll(async () => {
  env = await buildRouting();
  aId = await env.s.activeClient(env.owner, { name: "Answer A" });
  bId = await env.s.activeClient(env.owner, { name: "Answer B" });
  portal = createPortalService({ db: env.t.db, logger: (await import("pino")).default({ level: "silent" }), assignments: env.s.assignments });
  a = sessionFor(aId, await clientUser(aId));
  b = sessionFor(bId, await clientUser(bId));
});
afterAll(async () => {
  await env.destroy();
});

/** A new lead handed to business A by a person (the legal route), left `reserved`. */
async function leadForA(): Promise<{ leadId: string; assignmentId: string }> {
  const lead = await insertRawLead(env.t.admin, {});
  const result = await env.s.assignments.assign({ operator: env.owner, leadId: lead.id, clientId: aId, requestId: rid() });
  if (!result.ok) throw new Error(result.code);
  return { leadId: lead.id, assignmentId: result.assignmentId };
}

const assignmentRow = (id: string) => env.t.admin.selectFrom("lead_assignments").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const leadStatus = async (id: string) => (await env.t.admin.selectFrom("leads").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
const history = (id: string) => env.t.admin.selectFrom("lead_assignment_status_history").select(["from_status", "to_status", "actor_type", "actor_id", "reason"]).where("assignment_id", "=", id).orderBy("id").execute();

describe("accepting", () => {
  it("moves a lead the business has not yet been told about through `notified` to `accepted`, recording the person", async () => {
    const { assignmentId } = await leadForA();
    expect(await portal.accept(a, assignmentId, rid())).toEqual({ ok: true, alreadyAccepted: false });
    const row = await assignmentRow(assignmentId);
    expect(row.status).toBe("accepted");
    expect(row.accepted_at).not.toBeNull();
    expect(row.notified_at).not.toBeNull();
    const steps = await history(assignmentId);
    expect(steps.map((s) => `${s.from_status ?? "-"}>${s.to_status}`)).toEqual(["->reserved", "reserved>notified", "notified>accepted"]);
    expect(steps[2]).toMatchObject({ actor_type: "client_user", actor_id: a.userId, reason: "accepted_by_business" });
  });

  it("is idempotent: a second tap is fine and changes nothing", async () => {
    const { assignmentId } = await leadForA();
    await portal.accept(a, assignmentId, rid());
    const first = await assignmentRow(assignmentId);
    expect(await portal.accept(a, assignmentId, rid())).toEqual({ ok: true, alreadyAccepted: true });
    expect((await assignmentRow(assignmentId)).accepted_at).toEqual(first.accepted_at);
    expect(await history(assignmentId)).toHaveLength(3);
  });

  it("is audited with the person and the lead, and the audit trail carries no personal data", async () => {
    const { assignmentId, leadId } = await leadForA();
    await portal.accept(a, assignmentId, rid());
    const entry = await env.t.admin.selectFrom("audit_logs").selectAll().where("action", "=", "assignment.accepted").where("entity_id", "=", leadId).executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ actor_type: "client_user", actor_id: a.userId, entity_type: "lead" });
    expect(JSON.stringify(entry)).not.toMatch(/\+44|@/);
  });

  it("is refused for another business's lead, exactly as for one that does not exist", async () => {
    const { assignmentId } = await leadForA();
    expect(await portal.accept(b, assignmentId, rid())).toEqual({ ok: false, code: "not_found" });
    expect(await portal.accept(b, crypto.randomUUID(), rid())).toEqual({ ok: false, code: "not_found" });
    expect((await assignmentRow(assignmentId)).status).toBe("reserved");
  });

  it("is refused once the lead has ended", async () => {
    const { assignmentId } = await leadForA();
    await portal.decline(a, assignmentId, "too_busy", rid());
    expect(await portal.accept(a, assignmentId, rid())).toEqual({ ok: false, code: "not_open" });
  });
});

describe("declining", () => {
  it("ends the assignment with the reason, frees the lead, and tells the timeline", async () => {
    const { assignmentId, leadId } = await leadForA();
    expect(await portal.decline(a, assignmentId, "not_my_work", rid())).toEqual({ ok: true });
    const row = await assignmentRow(assignmentId);
    expect(row).toMatchObject({ status: "rejected", rejection_reason: "not_my_work" });
    expect(row.rejected_at).not.toBeNull();
    expect(await leadStatus(leadId)).toBe("new");
    expect((await history(assignmentId)).at(-1)).toMatchObject({ to_status: "rejected", actor_type: "client_user", actor_id: a.userId, reason: "not_my_work" });
    const events = await env.eventsOf(leadId);
    expect(events.find((e) => e.type === "lead.declined_by_business")).toMatchObject({ actor_type: "client_user", payload: { client_id: aId, reason: "not_my_work" } });
  });

  it("accepts only reasons from the closed list", async () => {
    const { assignmentId } = await leadForA();
    for (const reason of ["", "because", "OTHER", "wrong_area; drop table leads", "quality_issue"]) {
      expect(await portal.decline(a, assignmentId, reason, rid()), reason).toEqual({ ok: false, code: "invalid_reason" });
    }
    expect((await assignmentRow(assignmentId)).status).toBe("reserved");
    for (const reason of CLIENT_DECLINE_REASON_CODES) {
      const fresh = await leadForA();
      expect((await portal.decline(a, fresh.assignmentId, reason, rid())).ok, reason).toBe(true);
    }
  });

  it("cannot decline someone else's lead, or one it has already accepted", async () => {
    const { assignmentId } = await leadForA();
    expect(await portal.decline(b, assignmentId, "too_busy", rid())).toEqual({ ok: false, code: "not_found" });
    await portal.accept(a, assignmentId, rid());
    expect(await portal.decline(a, assignmentId, "too_busy", rid())).toEqual({ ok: false, code: "not_open" });
    expect((await assignmentRow(assignmentId)).status).toBe("accepted");
  });

  it("after a decline the router offers the lead to a DIFFERENT business, never back to the same one", async () => {
    await env.turnOn();
    const lead = await insertRawLead(env.t.admin, {});
    const routed = await env.routing.routeNext();
    expect(routed).toMatchObject({ outcome: "assigned", leadId: lead.id });
    if (routed?.outcome !== "assigned") return;
    const first = routed.clientId!;
    const session = first === aId ? a : b;
    const other = first === aId ? bId : aId;
    const assignment = (await env.assignmentsOf(lead.id))[0]!;
    expect(await portal.decline(session, assignment.id, "wrong_area", rid())).toEqual({ ok: true });

    expect(await env.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: lead.id, clientId: other });
    expect(await env.routing.routeNext()).toBeUndefined();
    // And when the second declines too, nobody is left: the lead is parked for a person, not offered back to the first.
    const second = (await env.assignmentsOf(lead.id)).find((row) => row.status === "reserved")!;
    await portal.decline(first === aId ? b : a, second.id, "too_busy", rid());
    expect(await env.routing.routeNext()).toMatchObject({ outcome: "no_candidates", leadId: lead.id });
    expect(await leadStatus(lead.id)).toBe("unroutable");
    await env.routing.setEnabled({ operator: env.owner, enabled: false, requestId: rid() });
  });
});

describe("accept and decline at the same instant", () => {
  it("leave exactly one outcome, consistent with the lead, however they interleave", async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 12; round += 1) {
      const { assignmentId, leadId } = await leadForA();
      const results = await Promise.all([
        portal.accept(a, assignmentId, rid()), portal.decline(a, assignmentId, "too_busy", rid()),
        portal.accept(a, assignmentId, rid()), portal.decline(a, assignmentId, "too_busy", rid()),
      ]);
      expect(results.every((r) => r.ok || r.code === "not_open")).toBe(true); // typed, never a thrown error
      const status = (await assignmentRow(assignmentId)).status;
      outcomes.push(status);
      expect(["accepted", "rejected"]).toContain(status);
      const winners = results.filter((r) => r.ok && !("alreadyAccepted" in r && r.alreadyAccepted));
      expect(winners.length).toBe(1);
      // The lead agrees: accepted keeps it assigned, rejected frees it.
      expect(await leadStatus(leadId)).toBe(status === "accepted" ? "assigned" : "new");
      expect((await history(assignmentId)).filter((h) => h.to_status === "accepted" || h.to_status === "rejected")).toHaveLength(1);
    }
    expect(new Set(outcomes).size).toBeGreaterThanOrEqual(1);
  });

  it("twenty simultaneous accepts record one acceptance", async () => {
    const { assignmentId } = await leadForA();
    const results = await Promise.all(Array.from({ length: 20 }, () => portal.accept(a, assignmentId, rid())));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.alreadyAccepted)).toHaveLength(1);
    expect((await history(assignmentId)).filter((h) => h.to_status === "accepted")).toHaveLength(1);
  });
});

describe("the database itself keeps a business to declining", () => {
  async function asClientUser(assignmentId: string, status: string, options: { id?: string | null; reason?: string | null; freeLead?: string } = {}) {
    return env.t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'client_user', true), set_config('app.actor_id', ${options.id === null ? "" : options.id ?? a.userId}, true), set_config('app.reason', ${options.reason === null ? "" : options.reason ?? "too_busy"}, true)`.execute(trx);
      await sql`update lead_assignments set status = ${status}::assignment_status where id = ${assignmentId}`.execute(trx);
      // Declining must also free the lead (another database guard); done here so this test isolates the actor rule.
      if (options.freeLead) await sql`update leads set status = 'new' where id = ${options.freeLead}`.execute(trx);
    });
  }

  it("a business user cannot cancel (take a lead back): that is for staff", async () => {
    const { assignmentId, leadId } = await leadForA();
    // freeLead: so the ONLY thing that can refuse this is the actor rule, not the "lead must be held" rule that also fires.
    await expect(asClientUser(assignmentId, "cancelled", { freeLead: leadId })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("needs an actor") });
    expect((await assignmentRow(assignmentId)).status).toBe("reserved");
  });

  it("a business user cannot decline without naming themselves and a reason", async () => {
    const { assignmentId, leadId } = await leadForA();
    await expect(asClientUser(assignmentId, "notified", { id: null })).resolves.toBeUndefined(); // moving to notified needs no reason
    await expect(asClientUser(assignmentId, "rejected", { id: null, freeLead: leadId })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("needs an actor") });
    await expect(asClientUser(assignmentId, "rejected", { reason: null, freeLead: leadId })).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("needs an actor") });
    await expect(asClientUser(assignmentId, "rejected", { freeLead: leadId })).resolves.toBeUndefined();
  });

  it("with no actor at all, ending an assignment is still refused", async () => {
    const { assignmentId, leadId } = await leadForA();
    await expect(
      env.t.admin.transaction().execute(async (trx) => {
        await sql`update lead_assignments set status = 'cancelled' where id = ${assignmentId}`.execute(trx);
        await sql`update leads set status = 'new' where id = ${leadId}`.execute(trx);
      }),
    ).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("needs an actor") });
  });
});

describe("recording what came of a lead", () => {
  async function accepted(): Promise<{ leadId: string; assignmentId: string }> {
    const lead = await leadForA();
    await portal.accept(a, lead.assignmentId, rid());
    return lead;
  }
  const log = (session: ClientSession, assignmentId: string, fields: Record<string, string | undefined>) => portal.logContact(session, assignmentId, fields);

  it("needs the lead to be accepted first", async () => {
    const { assignmentId } = await leadForA();
    expect(await log(a, assignmentId, { outcome: "spoke" })).toEqual({ ok: false, code: "not_accepted" });
    await portal.decline(a, assignmentId, "too_busy", rid());
    expect(await log(a, assignmentId, { outcome: "spoke" })).toEqual({ ok: false, code: "not_accepted" });
    expect(await env.t.admin.selectFrom("assignment_contact_attempts").select("id").where("assignment_id", "=", assignmentId).execute()).toHaveLength(0);
  });

  it("saves the call, who made the note, and shows the newest first on the lead", async () => {
    const { assignmentId } = await accepted();
    expect(await log(a, assignmentId, { outcome: "no_answer" })).toEqual({ ok: true });
    expect(await log(a, assignmentId, { outcome: "spoke", note: "  Wants a quote for Friday  " })).toEqual({ ok: true });
    expect(await log(a, assignmentId, { outcome: "won", jobValue: "£1,250.50", note: "" })).toEqual({ ok: true });
    const detail = await portal.lead(a, assignmentId, rid());
    expect(detail?.attempts.map((x) => x.outcome)).toEqual(["won", "spoke", "no_answer"]);
    expect(detail?.attempts[0]).toMatchObject({ jobValuePence: 125_050, note: null, by: "Pat" });
    expect(detail?.attempts[1]).toMatchObject({ note: "Wants a quote for Friday", jobValuePence: null });
  });

  it("refuses nonsense and keeps an amount to a quote or a win", async () => {
    const { assignmentId } = await accepted();
    for (const fields of [{}, { outcome: "invented" }, { outcome: "won", jobValue: "lots" }, { outcome: "won", jobValue: "-5" }, { outcome: "won", jobValue: "1e6" }, { outcome: "won", jobValue: "2000000" },
      { outcome: "spoke", jobValue: "100" }, { outcome: "lost", jobValue: "100" }, { outcome: "spoke", note: "x".repeat(1001) }]) {
      const result = await log(a, assignmentId, fields);
      expect(result, JSON.stringify(fields)).toMatchObject({ ok: false, code: "invalid" });
    }
    expect(await env.t.admin.selectFrom("assignment_contact_attempts").select("id").where("assignment_id", "=", assignmentId).execute()).toHaveLength(0);
    expect(await log(a, assignmentId, { outcome: "quote_sent", jobValue: "1,000,000" })).toEqual({ ok: true });
  });

  it("cannot be done to another business's lead, and the other business sees nothing of it", async () => {
    const { assignmentId } = await accepted();
    expect(await log(b, assignmentId, { outcome: "spoke" })).toEqual({ ok: false, code: "not_found" });
    expect(await log(a, assignmentId, { outcome: "spoke", note: "private" })).toEqual({ ok: true });
    const seenByB = await import("../../src/lib/db/client-scope").then(({ withClientScope }) => withClientScope(env.t.db, bId, (scoped) => sql`select id from assignment_contact_attempts`.execute(scoped)));
    expect(seenByB.rows).toEqual([]);
  });

  it("is append-only for the application: no edit of an outcome, no delete, only the note can be cleared", async () => {
    const { assignmentId } = await accepted();
    await log(a, assignmentId, { outcome: "spoke", note: "hello" });
    await expect(env.t.db.updateTable("assignment_contact_attempts").set({ outcome: "won" }).where("assignment_id", "=", assignmentId).execute()).rejects.toThrow(/permission denied/);
    await expect(env.t.db.deleteFrom("assignment_contact_attempts").where("assignment_id", "=", assignmentId).execute()).rejects.toThrow(/permission denied/);
    await env.t.db.updateTable("assignment_contact_attempts").set({ note: null }).where("assignment_id", "=", assignmentId).execute();
  });

  it("erasing the person clears what the business wrote about them, and keeps the outcome and the amount", async () => {
    const { assignmentId, leadId } = await accepted();
    await log(a, assignmentId, { outcome: "won", jobValue: "900", note: "Mrs Example, 07911 123456, side gate" });
    const result = await env.s.privacy.erase({ operator: env.owner, leadId, reason: "consumer_request", requestId: rid() });
    expect(result.ok).toBe(true);
    const row = await env.t.admin.selectFrom("assignment_contact_attempts").select(["outcome", "note", "job_value_pence"]).where("assignment_id", "=", assignmentId).executeTakeFirstOrThrow();
    expect(row).toEqual({ outcome: "won", note: null, job_value_pence: 90_000 });
  });
});

describe("most unanswered leads at once", () => {
  it("routing gives a business no more unanswered leads than it asked for, and more as it answers", async () => {
    const own = await buildRouting();
    try {
      const one = await own.s.activeClient(own.owner, { name: "Limited" });
      await own.t.admin.updateTable("clients").set({ max_open_leads: 1, priority: 1 }).where("id", "=", one).execute();
      const spare = await own.s.activeClient(own.owner, { name: "Spare" });
      await own.t.admin.updateTable("clients").set({ priority: 50 }).where("id", "=", spare).execute();
      await own.turnOn();
      const portalOwn = createPortalService({ db: own.t.db, logger: (await import("pino")).default({ level: "silent" }), assignments: own.s.assignments });
      const person = await own.t.admin.insertInto("client_users").values({ client_id: one, email: `m-${crypto.randomUUID().slice(0, 6)}@x.example`, name: "M" }).returning("id").executeTakeFirstOrThrow();
      const session = sessionFor(one, person.id);

      const first = await insertRawLead(own.t.admin, {});
      expect(await own.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: first.id, clientId: one });
      const second = await insertRawLead(own.t.admin, {});
      expect(await own.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: second.id, clientId: spare }); // Limited holds one unanswered
      const run = (await own.runsOf(second.id)).at(-1)!;
      expect(JSON.stringify(run.candidates)).toContain("max_open_leads_reached");

      await portalOwn.accept(session, (await own.assignmentsOf(first.id))[0]!.id, rid());
      const third = await insertRawLead(own.t.admin, {});
      expect(await own.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: third.id, clientId: one }); // answered: room again
    } finally {
      await own.destroy();
    }
  });
});
