import { sql } from "kysely";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DISPUTE_DECISION_REASONS, DISPUTE_REASON_CODES, DISPUTE_WINDOW_DAYS } from "../../src/config/disputes";
import { createBillingService } from "../../src/modules/billing";
import type { ClientSession } from "../../src/modules/clientauth";
import { createDisputeService } from "../../src/modules/disputes";
import { createPortalService } from "../../src/modules/portal";
import { buildRouting, type RoutingEnv } from "../helpers/routing";
import { insertRawLead } from "../helpers/raw";

/**
 * Disputes (stage 6, slice 4; docs/00 D55-D58). What must hold: only the business that holds a lead can dispute it, once, within the window;
 * only a named member of staff can decide, once; an upheld dispute gives the money back exactly once and stops the lead being sold again
 * by itself; a rejected one changes nothing about the money; and a business and staff acting at the same instant leave one consistent outcome.
 */
let env: RoutingEnv;
let disputes: ReturnType<typeof createDisputeService>;
let billing: ReturnType<typeof createBillingService>;
let portal: ReturnType<typeof createPortalService>;
let aId: string;
let bId: string;
let a: ClientSession;
let b: ClientSession;

const PRICE = 3500;
const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;
const silent = pino({ level: "silent" });

async function clientUser(clientId: string): Promise<ClientSession> {
  const row = await env.t.admin.insertInto("client_users").values({ client_id: clientId, email: `u-${crypto.randomUUID().slice(0, 8)}@x.example`, name: "Pat" }).returning("id").executeTakeFirstOrThrow();
  return { sessionId: crypto.randomUUID(), userId: row.id, clientId, clientName: "Biz", name: "Pat", email: "p@x.example", role: "owner" };
}

beforeAll(async () => {
  env = await buildRouting({ price: PRICE });
  billing = createBillingService({ db: env.t.db, logger: silent });
  disputes = createDisputeService({ db: env.t.db, logger: silent });
  portal = createPortalService({ db: env.t.db, logger: silent, assignments: env.s.assignments });
  aId = await env.s.activeClient(env.owner, { name: "Dispute A" });
  bId = await env.s.activeClient(env.owner, { name: "Dispute B" });
  a = await clientUser(aId);
  b = await clientUser(bId);
});
afterAll(async () => {
  await env.destroy();
});

async function held(status: "reserved" | "notified" | "accepted" = "notified", clientId = aId, session = a) {
  const lead = await insertRawLead(env.t.admin, {});
  const result = await env.s.assignments.assign({ operator: env.owner, leadId: lead.id, clientId, requestId: rid() });
  if (!result.ok) throw new Error(result.code);
  if (status === "accepted") expect((await portal.accept(session, result.assignmentId, rid())).ok).toBe(true);
  if (status === "notified") await env.s.assignments.markSent({ operator: env.owner, assignmentId: result.assignmentId, requestId: rid() });
  return { leadId: lead.id, assignmentId: result.assignmentId };
}
const raise = (session: ClientSession, assignmentId: string, fields: Record<string, string> = { reason: "wrong_number", description: "Rang twice, a different person answered" }) => disputes.raise(session, assignmentId, fields, rid());
const decide = (disputeId: string, fields: Record<string, string>, operator = env.owner) => disputes.decide({ operator, disputeId, fields, requestId: rid() });
const UPHOLD = { outcome: "uphold", resolution: "credit_refund", decisionReason: "confirmed_bad_number" };
const REJECT = { outcome: "reject", decisionReason: "contact_was_made" };

const assignmentRow = (id: string) => env.t.admin.selectFrom("lead_assignments").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const leadRow = (id: string) => env.t.admin.selectFrom("leads").select("status").where("id", "=", id).executeTakeFirstOrThrow();
const disputeRow = (id: string) => env.t.admin.selectFrom("disputes").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const chargeOf = (assignmentId: string) => env.t.admin.selectFrom("lead_charges").selectAll().where("assignment_id", "=", assignmentId).executeTakeFirstOrThrow();
const history = (id: string) => env.t.admin.selectFrom("lead_assignment_status_history").select(["from_status", "to_status", "actor_type", "actor_id", "reason"]).where("assignment_id", "=", id).orderBy("id").execute();

describe("a business reports a problem", () => {
  for (const status of ["reserved", "notified", "accepted"] as const) {
    it(`with a lead it holds (${status}): the lead becomes disputed, the charge stays, the details stay visible`, async () => {
      const { assignmentId, leadId } = await held(status);
      const result = await raise(a, assignmentId);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((await assignmentRow(assignmentId)).status).toBe("disputed");
      expect(await leadRow(leadId)).toEqual({ status: "assigned" });
      expect((await chargeOf(assignmentId)).status).toBe("posted");
      expect(await disputeRow(result.disputeId)).toMatchObject({ status: "open", client_id: aId, reason: "wrong_number", raised_by: a.userId, decided_by: null });
      expect((await portal.lead(a, assignmentId, rid()))?.contactState).toBe("visible");
      const steps = (await history(assignmentId)).map((h) => `${h.from_status ?? "-"}>${h.to_status}`);
      expect(steps.at(-1)).toBe(`${status === "accepted" ? "accepted" : "notified"}>disputed`);
    });
  }

  it("is audited and on the lead's timeline, with codes and ids only", async () => {
    const { assignmentId, leadId } = await held("accepted");
    const result = await raise(a, assignmentId, { reason: "spam", description: "Mrs Example, 07911 123456, said she never asked" });
    if (!result.ok) throw new Error(result.code);
    const entry = await env.t.admin.selectFrom("audit_logs").selectAll().where("action", "=", "dispute.raised").where("entity_id", "=", leadId).executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ actor_type: "client_user", actor_id: a.userId, reason: "spam" });
    expect(JSON.stringify(entry)).not.toMatch(/Example|07911|@/);
    expect((await env.eventsOf(leadId)).find((e) => e.type === "lead.disputed")).toMatchObject({ actor_type: "client_user", payload: { dispute_id: result.disputeId, reason: "spam" } });
  });

  it("checks what was typed: a reason from the list, 'something else' needs words, length limits", async () => {
    const { assignmentId } = await held("accepted");
    for (const fields of [{}, { reason: "bad_vibes" }, { reason: "other" }, { reason: "other", description: "no" }, { reason: "spam", description: "x".repeat(2001) }]) {
      expect(await raise(a, assignmentId, fields as Record<string, string>), JSON.stringify(fields)).toMatchObject({ ok: false, code: "invalid_input" });
    }
    expect((await assignmentRow(assignmentId)).status).toBe("accepted");
    for (const reason of DISPUTE_REASON_CODES) {
      const fresh = await held("accepted");
      expect((await raise(a, fresh.assignmentId, { reason, description: "Something is wrong with it" })).ok, reason).toBe(true);
    }
  });

  it("only for a lead it holds: not another business's, not one that has ended, not one already disputed", async () => {
    const mine = await held("accepted");
    expect(await raise(b, mine.assignmentId)).toEqual({ ok: false, code: "not_found" });
    expect(await raise(a, crypto.randomUUID())).toEqual({ ok: false, code: "not_found" });
    expect(await raise(a, "not-an-id")).toEqual({ ok: false, code: "not_found" });
    const declined = await held("notified");
    await portal.decline(a, declined.assignmentId, "too_busy", rid());
    expect(await raise(a, declined.assignmentId)).toEqual({ ok: false, code: "not_disputable" });
    expect((await raise(a, mine.assignmentId)).ok).toBe(true);
    expect(await raise(a, mine.assignmentId)).toEqual({ ok: false, code: "not_disputable" }); // it is already disputed
  });

  it(`only within ${DISPUTE_WINDOW_DAYS} days of being told about it`, async () => {
    const inside = await held("accepted");
    await env.t.admin.updateTable("lead_assignments").set({ notified_at: sql<Date>`now() - interval '6 days 23 hours'` }).where("id", "=", inside.assignmentId).execute();
    expect((await raise(a, inside.assignmentId)).ok).toBe(true);
    const outside = await held("accepted");
    await env.t.admin.updateTable("lead_assignments").set({ notified_at: sql<Date>`now() - interval '7 days 1 hour'` }).where("id", "=", outside.assignmentId).execute();
    expect(await raise(a, outside.assignmentId)).toEqual({ ok: false, code: "window_closed" });
    expect((await assignmentRow(outside.assignmentId)).status).toBe("accepted");
  });

  it("RACE: twelve simultaneous reports of one lead make exactly one dispute", async () => {
    const { assignmentId } = await held("accepted");
    const results = await Promise.all(Array.from({ length: 12 }, () => raise(a, assignmentId)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.every((r) => r.ok || ["not_disputable", "already_disputed"].includes(r.code))).toBe(true);
    expect(await env.t.admin.selectFrom("disputes").select("id").where("assignment_id", "=", assignmentId).execute()).toHaveLength(1);
  });
});

describe("withdrawing", () => {
  it("returns the lead to accepted, refunds nothing, and the business may report it once more", async () => {
    const { assignmentId } = await held("accepted");
    const first = await raise(a, assignmentId);
    if (!first.ok) throw new Error(first.code);
    expect(await disputes.withdraw(a, first.disputeId, rid())).toEqual({ ok: true });
    expect((await assignmentRow(assignmentId)).status).toBe("accepted");
    expect((await chargeOf(assignmentId)).status).toBe("posted");
    expect((await disputeRow(first.disputeId)).status).toBe("withdrawn");
    const second = await raise(a, assignmentId, { reason: "duplicate", description: "I did already have this one" });
    expect(second.ok).toBe(true);
  });

  it("cannot be done by another business, twice, or after a decision", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    expect(await disputes.withdraw(b, d.disputeId, rid())).toEqual({ ok: false, code: "not_found" });
    expect(await disputes.withdraw(a, d.disputeId, rid())).toEqual({ ok: true });
    expect(await disputes.withdraw(a, d.disputeId, rid())).toEqual({ ok: false, code: "not_open" });
    const other = await held("accepted");
    const decided = await raise(a, other.assignmentId);
    if (!decided.ok) throw new Error(decided.code);
    await decide(decided.disputeId, REJECT);
    expect(await disputes.withdraw(a, decided.disputeId, rid())).toEqual({ ok: false, code: "not_open" });
  });
});

describe("staff decide: upheld", () => {
  it("refunds a prepaid business exactly once, ends the assignment as refunded, and stops the lead being routed again by itself", async () => {
    const prepaid = await env.s.activeClient(env.owner, { name: "Prepaid Disputer" });
    await billing.setMode({ operator: env.owner, clientId: prepaid, mode: "prepaid", requestId: rid() });
    await billing.post({ operator: env.owner, clientId: prepaid, postingId: crypto.randomUUID(), fields: { kind: "top_up", reason: "bank_transfer", amount: "100" }, requestId: rid() });
    const session = await clientUser(prepaid);
    const { assignmentId, leadId } = await held("accepted", prepaid, session);
    const walletOf = async () => Number((await env.t.admin.selectFrom("client_wallets").select("balance_pence").where("client_id", "=", prepaid).executeTakeFirstOrThrow()).balance_pence);
    expect(await walletOf()).toBe(10_000 - PRICE);

    const d = await raise(session, assignmentId);
    if (!d.ok) throw new Error(d.code);
    expect(await walletOf()).toBe(10_000 - PRICE); // still charged while it is being looked at
    expect(await decide(d.disputeId, UPHOLD)).toEqual({ ok: true, outcome: "upheld" });

    expect(await walletOf()).toBe(10_000);
    expect((await chargeOf(assignmentId)).status).toBe("reversed");
    expect((await assignmentRow(assignmentId)).status).toBe("refunded");
    expect(await disputeRow(d.disputeId)).toMatchObject({ status: "upheld", resolution: "credit_refund", decided_by: env.owner.id, decision_reason: "confirmed_bad_number" });
    expect((await disputeRow(d.disputeId)).decided_at).not.toBeNull();
    expect((await history(assignmentId)).at(-1)).toMatchObject({ from_status: "disputed", to_status: "refunded", actor_type: "staff_user", actor_id: env.owner.id, reason: "confirmed_bad_number" });
    const refunds = await env.t.admin.selectFrom("credit_ledger").select("id").where("assignment_id", "=", assignmentId).where("entry_type", "=", "refund").execute();
    expect(refunds).toHaveLength(1);
    expect(await billing.problems()).toEqual([]);

    // The lead is free, and nothing re-sells it by itself.
    expect(await leadRow(leadId)).toEqual({ status: "new" });
    expect((await env.eventsOf(leadId)).map((e) => e.type)).toEqual(expect.arrayContaining(["lead.disputed", "lead.dispute_decided", "lead.routing_stopped"]));
    await env.turnOn();
    expect(await env.routing.routeNext()).toBeUndefined();
    await env.routing.setEnabled({ operator: env.owner, enabled: false, requestId: rid() });
  });

  it("for an invoiced business, reverses the invoice charge", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    await decide(d.disputeId, { ...UPHOLD, resolution: "replacement_lead", decisionReason: "goodwill" });
    expect(await chargeOf(assignmentId)).toMatchObject({ status: "reversed", source: "invoice" });
    expect((await disputeRow(d.disputeId)).resolution).toBe("replacement_lead");
    expect(await billing.problems()).toEqual([]);
  });

  it("the audit trail has the person and the code, never the business's words", async () => {
    const { assignmentId, leadId } = await held("accepted");
    const d = await raise(a, assignmentId, { reason: "other", description: "Caller was Mrs Example on 07911 123456" });
    if (!d.ok) throw new Error(d.code);
    await decide(d.disputeId, UPHOLD);
    const entry = await env.t.admin.selectFrom("audit_logs").selectAll().where("action", "=", "dispute.upheld").where("entity_id", "=", leadId).executeTakeFirstOrThrow();
    expect(entry).toMatchObject({ actor_id: env.owner.id, reason: "confirmed_bad_number" });
    expect(JSON.stringify(entry)).not.toMatch(/Example|07911/);
  });
});

describe("staff decide: not upheld", () => {
  it("returns the lead to the business as accepted, keeps the charge, and the dispute is final (no raising it again)", async () => {
    const { assignmentId, leadId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    expect(await decide(d.disputeId, REJECT)).toEqual({ ok: true, outcome: "rejected" });
    expect((await assignmentRow(assignmentId)).status).toBe("accepted");
    expect((await chargeOf(assignmentId)).status).toBe("posted");
    expect(await leadRow(leadId)).toEqual({ status: "assigned" });
    expect(await disputeRow(d.disputeId)).toMatchObject({ status: "rejected", resolution: null, decision_reason: "contact_was_made" });
    expect(await raise(a, assignmentId)).toEqual({ ok: false, code: "already_disputed" });
  });
});

describe("what a decision must be", () => {
  it("one outcome and a code that belongs to it; an upheld one needs a resolution", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    const bad: Array<[Record<string, string>, string]> = [
      [{}, "invalid_outcome"], [{ outcome: "maybe", decisionReason: "goodwill" }, "invalid_outcome"],
      [{ outcome: "uphold", resolution: "credit_refund" }, "invalid_decision_reason"], [{ outcome: "uphold", resolution: "credit_refund", decisionReason: "contact_was_made" }, "invalid_decision_reason"],
      [{ outcome: "reject", decisionReason: "confirmed_spam" }, "invalid_decision_reason"], [{ outcome: "reject", decisionReason: "because i said so" }, "invalid_decision_reason"],
      [{ outcome: "uphold", decisionReason: "goodwill" }, "invalid_resolution"], [{ outcome: "uphold", resolution: "free_money", decisionReason: "goodwill" }, "invalid_resolution"],
    ];
    for (const [fields, code] of bad) expect(await decide(d.disputeId, fields), JSON.stringify(fields)).toEqual({ ok: false, code });
    expect((await disputeRow(d.disputeId)).status).toBe("open");
    expect((await assignmentRow(assignmentId)).status).toBe("disputed");
    expect(await decide("not-an-id", UPHOLD)).toEqual({ ok: false, code: "not_found" });
    expect(await decide(crypto.randomUUID(), UPHOLD)).toEqual({ ok: false, code: "not_found" });
  });

  it("every decision code belongs to exactly one outcome", () => {
    const outcomes = new Set(Object.values(DISPUTE_DECISION_REASONS).map((r) => r.outcome));
    expect(outcomes).toEqual(new Set(["upheld", "rejected"]));
  });

  it("a decided dispute cannot be decided again", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    expect((await decide(d.disputeId, UPHOLD)).ok).toBe(true);
    expect(await decide(d.disputeId, REJECT)).toEqual({ ok: false, code: "not_open" });
    expect(await decide(d.disputeId, UPHOLD)).toEqual({ ok: false, code: "not_open" });
  });
});

describe("simultaneous actions leave one consistent outcome", () => {
  it("two staff deciding at once: one wins, the other is told it is already decided, the money moves once", async () => {
    for (let round = 0; round < 8; round += 1) {
      const { assignmentId } = await held("accepted");
      const d = await raise(a, assignmentId);
      if (!d.ok) throw new Error(d.code);
      const results = await Promise.all([decide(d.disputeId, UPHOLD), decide(d.disputeId, REJECT), decide(d.disputeId, UPHOLD), decide(d.disputeId, REJECT)]);
      expect(results.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
      expect(results.every((r) => r.ok || r.code === "not_open")).toBe(true);
      const status = (await disputeRow(d.disputeId)).status;
      const assignment = (await assignmentRow(assignmentId)).status;
      expect(assignment).toBe(status === "upheld" ? "refunded" : "accepted");
      expect((await chargeOf(assignmentId)).status).toBe(status === "upheld" ? "reversed" : "posted");
    }
    expect(await billing.problems()).toEqual([]);
  });

  it("the business withdrawing while staff uphold: exactly one happens, and the state agrees with it", async () => {
    for (let round = 0; round < 10; round += 1) {
      const { assignmentId, leadId } = await held("accepted");
      const d = await raise(a, assignmentId);
      if (!d.ok) throw new Error(d.code);
      const [withdrawn, decided] = await Promise.all([disputes.withdraw(a, d.disputeId, rid()), decide(d.disputeId, UPHOLD)]);
      expect([withdrawn.ok, decided.ok].filter(Boolean), `round ${round}`).toHaveLength(1);
      const dispute = await disputeRow(d.disputeId);
      if (withdrawn.ok) {
        expect(dispute.status).toBe("withdrawn");
        expect((await assignmentRow(assignmentId)).status).toBe("accepted");
        expect((await chargeOf(assignmentId)).status).toBe("posted");
        expect((await leadRow(leadId)).status).toBe("assigned");
      } else {
        expect(dispute.status).toBe("upheld");
        expect((await assignmentRow(assignmentId)).status).toBe("refunded");
        expect((await chargeOf(assignmentId)).status).toBe("reversed");
      }
    }
    expect(await billing.problems()).toEqual([]);
  });

  it("staff upholding while staff take the lead back by hand cannot happen twice: the lead is only ever released once", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    // A disputed lead cannot be cancelled by hand (it is not reserved or notified), so staff must go through the dispute.
    expect(await env.s.assignments.cancel({ operator: env.owner, assignmentId, reason: "no_response", requestId: rid() })).toEqual({ ok: false, code: "not_cancellable" });
  });
});

describe("the database keeps it honest on its own", () => {
  async function asActor(actor: "staff_user" | "client_user" | "system" | null, actorId: string | null, work: (trx: typeof env.t.admin) => Promise<unknown>) {
    return env.t.admin.transaction().execute(async (trx) => {
      if (actor) await sql`select set_config('app.actor_type', ${actor}, true), set_config('app.actor_id', ${actorId ?? ""}, true), set_config('app.reason', 'test', true)`.execute(trx);
      return work(trx);
    });
  }

  it("a decision needs a NAMED member of staff acting as themselves; a business or the system cannot decide", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    const uphold = (trx: typeof env.t.admin, decidedBy: string) =>
      sql`update disputes set status = 'upheld', resolution = 'credit_refund', decided_by = ${decidedBy}, decided_at = now(), decision_reason = 'goodwill' where id = ${d.disputeId}`.execute(trx);
    await expect(asActor("client_user", a.userId, (t) => uphold(t, env.owner.id))).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("only a named member of staff") });
    await expect(asActor("system", null, (t) => uphold(t, env.owner.id))).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("only a named member of staff") });
    await expect(asActor(null, null, (t) => uphold(t, env.owner.id))).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("only a named member of staff") });
    await expect(asActor("staff_user", env.staff.id, (t) => uphold(t, env.owner.id))).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("only a named member of staff") }); // acting as someone else
    expect((await disputeRow(d.disputeId)).status).toBe("open");
  });

  it("only the business can withdraw; what was claimed cannot be edited; a decided or withdrawn dispute is final; it cannot be deleted", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId, { reason: "spam", description: "words" });
    if (!d.ok) throw new Error(d.code);
    await expect(asActor("staff_user", env.owner.id, (t) => sql`update disputes set status = 'withdrawn' where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ message: expect.stringContaining("only the business can withdraw") });
    const elsewhere = await held("accepted");
    for (const change of [sql`reason = 'duplicate'`, sql`client_id = ${bId}`, sql`raised_by = ${b.userId}`, sql`assignment_id = ${elsewhere.assignmentId}`, sql`created_at = created_at - interval '1 day'`]) {
      await expect(asActor("system", null, (t) => sql`update disputes set ${change} where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ message: expect.stringContaining("cannot be changed") });
    }
    await expect(asActor("system", null, (t) => sql`update disputes set description = 'rewritten' where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ message: expect.stringContaining("only be cleared") });
    await expect(asActor("system", null, (t) => sql`delete from disputes where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ message: expect.stringContaining("cannot be deleted") });
    await decide(d.disputeId, REJECT);
    await expect(asActor("client_user", a.userId, (t) => sql`update disputes set status = 'withdrawn' where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ message: expect.stringContaining("final") });
    await expect(asActor("staff_user", env.owner.id, (t) => sql`update disputes set resolution = 'credit_refund' where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ code: "23514" });
  });

  it("an upheld dispute must have a resolution, a decider and a reason (the table refuses anything else)", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId);
    if (!d.ok) throw new Error(d.code);
    await expect(asActor("staff_user", env.owner.id, (t) => sql`update disputes set status = 'upheld', decided_by = ${env.owner.id}, decided_at = now(), decision_reason = 'goodwill' where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ code: "23514" });
    await expect(asActor("staff_user", env.owner.id, (t) => sql`update disputes set status = 'upheld', resolution = 'credit_refund', decided_at = now() where id = ${d.disputeId}`.execute(t))).rejects.toMatchObject({ code: "23514" });
  });
});

describe("what each side sees", () => {
  it("a business sees its own disputes and their outcome, never another's, and cannot touch them directly", async () => {
    const mine = await held("accepted");
    const theirs = await held("accepted", bId, b);
    const a1 = await raise(a, mine.assignmentId);
    const b1 = await raise(b, theirs.assignmentId);
    if (!a1.ok || !b1.ok) throw new Error("setup");
    await decide(a1.disputeId, REJECT);
    const list = await disputes.forBusiness(a);
    expect(list.map((x) => x.id)).toContain(a1.disputeId);
    expect(list.map((x) => x.id)).not.toContain(b1.disputeId);
    expect(list.find((x) => x.id === a1.disputeId)).toMatchObject({ status: "rejected", decidedBy: null }); // the staff member's email is not shown to the business
    expect(await disputes.forAssignment(a, theirs.assignmentId)).toEqual([]);
    const { withClientScope } = await import("../../src/lib/db/client-scope");
    const seen = await withClientScope(env.t.db, aId, (scoped) => sql<{ id: string }>`select id from disputes`.execute(scoped));
    expect(seen.rows.map((r) => r.id)).not.toContain(b1.disputeId);
    const changed = await withClientScope(env.t.db, aId, (scoped) => sql`update disputes set description = null where id = ${b1.disputeId}`.execute(scoped));
    expect(Number(changed.numAffectedRows)).toBe(0);
  });

  it("staff see the queue with the open ones first (oldest first) and the business's words", async () => {
    const { assignmentId } = await held("accepted");
    const d = await raise(a, assignmentId, { reason: "other", description: "Staff should be able to read this" });
    if (!d.ok) throw new Error(d.code);
    const { open } = await disputes.queueFor();
    const times = open.map((x) => x.createdAt.getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(open.find((x) => x.id === d.disputeId)).toMatchObject({ description: "Staff should be able to read this", clientName: "Dispute A", chargePence: PRICE });
    expect(await disputes.openCount()).toBeGreaterThanOrEqual(1);
  });

  it("erasing the person clears what the business wrote in the dispute, and keeps the reason and the outcome", async () => {
    const { assignmentId, leadId } = await held("accepted");
    const d = await raise(a, assignmentId, { reason: "wrong_number", description: "It was Mrs Example, 07911 123456" });
    if (!d.ok) throw new Error(d.code);
    await decide(d.disputeId, UPHOLD);
    expect((await env.s.privacy.erase({ operator: env.owner, leadId, reason: "consumer_request", requestId: rid() })).ok).toBe(true);
    expect(await disputeRow(d.disputeId)).toMatchObject({ description: null, reason: "wrong_number", status: "upheld" });
  });
});
