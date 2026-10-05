import { sql } from "kysely";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBillingService } from "../../src/modules/billing";
import { createPortalService } from "../../src/modules/portal";
import type { ClientSession } from "../../src/modules/clientauth";
import { buildRouting, type RoutingEnv } from "../helpers/routing";
import { insertRawLead } from "../helpers/raw";

/**
 * Money (stage 6, slice 3; docs/00 D50-D54). What must hold, whatever happens at once:
 *   - every assignment has exactly ONE charge, made in the assignment's own transaction;
 *   - a business paying from credit can never go below zero, and a lead it cannot pay for is never assigned to it;
 *   - a lead that ends without being kept is refunded exactly once, by every route that can end it;
 *   - the application can read the money tables but never write them;
 *   - the reconciliation (wallet = ledger = charges) is empty after any amount of concurrent activity, and CAN fail.
 */
let env: RoutingEnv;
let billing: ReturnType<typeof createBillingService>;
let portal: ReturnType<typeof createPortalService>;

const PRICE = 3500;
const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;
const silent = pino({ level: "silent" });

beforeAll(async () => {
  env = await buildRouting({ price: PRICE });
  billing = createBillingService({ db: env.t.db, logger: silent });
  portal = createPortalService({ db: env.t.db, logger: silent, assignments: env.s.assignments });
});
afterAll(async () => {
  await env.destroy();
});

async function client(options: { mode?: "invoice" | "prepaid"; credit?: number; name?: string } = {}): Promise<string> {
  const id = await env.s.activeClient(env.owner, { name: options.name });
  if (options.mode === "prepaid") expect(await billing.setMode({ operator: env.owner, clientId: id, mode: "prepaid", requestId: rid() })).toEqual({ ok: true });
  if (options.credit) await credit(id, options.credit);
  return id;
}

async function credit(clientId: string, pence: number, kind: "top_up" | "grant" | "adjustment" = "grant", reason = "goodwill") {
  const result = await billing.post({ operator: env.owner, clientId, postingId: crypto.randomUUID(), fields: { kind, reason: kind === "grant" ? reason : kind === "top_up" ? "bank_transfer" : "error_correction", amount: (pence / 100).toFixed(2) }, requestId: rid() });
  if (!result.ok) throw new Error(`credit failed: ${result.code}`);
  return result;
}

const lead = () => insertRawLead(env.t.admin, {});
async function assign(clientId: string, leadId?: string) {
  const id = leadId ?? (await lead()).id;
  const result = await env.s.assignments.assign({ operator: env.owner, leadId: id, clientId, requestId: rid() });
  return { result, leadId: id };
}
async function assigned(clientId: string): Promise<{ assignmentId: string; leadId: string }> {
  const { result, leadId } = await assign(clientId);
  if (!result.ok) throw new Error(`assign failed: ${result.code}`);
  return { assignmentId: result.assignmentId, leadId };
}

const wallet = async (clientId: string) => Number((await env.t.admin.selectFrom("client_wallets").select("balance_pence").where("client_id", "=", clientId).executeTakeFirst())?.balance_pence ?? 0);
const ledger = (clientId: string) => env.t.admin.selectFrom("credit_ledger").selectAll().where("client_id", "=", clientId).orderBy("id").execute();
const chargeOf = (assignmentId: string) => env.t.admin.selectFrom("lead_charges").selectAll().where("assignment_id", "=", assignmentId).execute();
const problems = () => billing.problems();

/** Ends an assignment the way the system (not a person) would: delivery failed, expired. */
async function endAs(assignmentId: string, leadId: string, status: "delivery_failed" | "expired") {
  await env.t.admin.transaction().execute(async (trx) => {
    await sql`select set_config('app.actor_type', 'system', true), set_config('app.reason', 'test', true), set_config('app.request_id', 'test', true)`.execute(trx);
    await sql`update lead_assignments set status = ${status}::assignment_status where id = ${assignmentId}`.execute(trx);
    await sql`update leads set status = 'new' where id = ${leadId}`.execute(trx);
  });
}

describe("a business that is invoiced (the default)", () => {
  it("is charged exactly once per assignment, in a record staff invoice from; no credit is touched", async () => {
    const id = await client();
    const { assignmentId } = await assigned(id);
    const charges = await chargeOf(assignmentId);
    expect(charges).toHaveLength(1);
    expect(charges[0]).toMatchObject({ client_id: id, amount_pence: PRICE, source: "invoice", status: "posted", ledger_entry_id: null, reversed_at: null });
    expect(await ledger(id)).toEqual([]);
    expect(await wallet(id)).toBe(0);
    expect(await problems()).toEqual([]);
  });

  it("the charge is reversed (not deleted) when the lead is taken back", async () => {
    const id = await client();
    const { assignmentId } = await assigned(id);
    expect(await env.s.assignments.cancel({ operator: env.owner, assignmentId, reason: "client_unavailable", requestId: rid() })).toEqual({ ok: true });
    const [charge] = await chargeOf(assignmentId);
    expect(charge).toMatchObject({ status: "reversed", amount_pence: PRICE, source: "invoice" });
    expect(charge!.reversed_at).not.toBeNull();
    expect(await problems()).toEqual([]);
  });

  it("a free lead (price zero) is recorded at zero and never needs credit, even for a prepaid business with nothing", async () => {
    const id = await client({ mode: "prepaid" });
    const l = await lead();
    await env.t.admin.updateTable("leads").set({ sale_model: "exclusive" }).where("id", "=", l.id).execute();
    const row = await env.t.admin.insertInto("lead_assignments").values({ lead_id: l.id, client_id: id, sale_type: "exclusive", assigned_by: "staff", assigned_by_user_id: env.owner.id, price_pence: 0 }).returning("id").executeTakeFirstOrThrow();
    expect((await chargeOf(row.id))[0]).toMatchObject({ amount_pence: 0, source: "invoice", status: "posted" });
    expect(await ledger(id)).toEqual([]);
    expect(await problems()).toEqual([]);
  });
});

describe("a business that pays from credit", () => {
  it("is charged from its balance when a lead is assigned: balance, ledger and charge agree", async () => {
    const id = await client({ mode: "prepaid", credit: 10_000 });
    const { assignmentId } = await assigned(id);
    expect(await wallet(id)).toBe(10_000 - PRICE);
    const entries = await ledger(id);
    expect(entries.map((e) => [e.entry_type, Number(e.amount_pence), Number(e.balance_after_pence)])).toEqual([["grant", 10_000, 10_000], ["lead_charge", -PRICE, 10_000 - PRICE]]);
    const [charge] = await chargeOf(assignmentId);
    expect(charge).toMatchObject({ source: "credit_balance", status: "posted", amount_pence: PRICE });
    expect(Number(charge!.ledger_entry_id)).toBe(Number(entries[1]!.id));
    expect(entries[1]!.assignment_id).toBe(assignmentId);
    expect(entries[1]!.idempotency_key).toBe(`charge:${assignmentId}`);
    expect(await problems()).toEqual([]);
  });

  it("refuses a lead it cannot pay for: no assignment, no charge, no ledger entry, the lead stays free", async () => {
    const id = await client({ mode: "prepaid", credit: PRICE - 1 });
    const before = (await ledger(id)).length;
    const { result, leadId } = await assign(id);
    expect(result).toEqual({ ok: false, code: "insufficient_credit" });
    expect(await env.t.admin.selectFrom("lead_assignments").select("id").where("lead_id", "=", leadId).execute()).toHaveLength(0);
    expect((await env.t.admin.selectFrom("leads").select("status").where("id", "=", leadId).executeTakeFirstOrThrow()).status).toBe("new");
    expect(await wallet(id)).toBe(PRICE - 1);
    expect(await ledger(id)).toHaveLength(before);
    expect(await problems()).toEqual([]);
  });

  it("exactly enough is enough, and then the next is refused", async () => {
    const id = await client({ mode: "prepaid", credit: PRICE });
    expect((await assign(id)).result.ok).toBe(true);
    expect(await wallet(id)).toBe(0);
    expect((await assign(id)).result).toEqual({ ok: false, code: "insufficient_credit" });
  });

  it("a business with no wallet at all (never given credit) cannot be assigned a paid lead", async () => {
    const id = await client({ mode: "prepaid" });
    expect((await assign(id)).result).toEqual({ ok: false, code: "insufficient_credit" });
    expect(await ledger(id)).toEqual([]); // the refusal undid everything, including the empty wallet it would have created
    expect(await problems()).toEqual([]);
  });

  it("moving a lead to another business refunds the first and charges the second, in one transaction", async () => {
    const first = await client({ mode: "prepaid", credit: 5_000 });
    const second = await client({ mode: "prepaid", credit: 5_000 });
    const { assignmentId } = await assigned(first);
    const moved = await env.s.assignments.reassign({ operator: env.owner, assignmentId, toClientId: second, reason: "wrong_area", requestId: rid() });
    expect(moved.ok).toBe(true);
    expect(await wallet(first)).toBe(5_000);
    expect(await wallet(second)).toBe(5_000 - PRICE);
    expect(await problems()).toEqual([]);
  });

  it("a move to a business that cannot pay changes nothing at all (the first still holds the lead and is still charged)", async () => {
    const first = await client({ mode: "prepaid", credit: 5_000 });
    const poor = await client({ mode: "prepaid", credit: 100 });
    const { assignmentId } = await assigned(first);
    const moved = await env.s.assignments.reassign({ operator: env.owner, assignmentId, toClientId: poor, reason: "wrong_area", requestId: rid() });
    expect(moved).toEqual({ ok: false, code: "insufficient_credit" });
    expect(await wallet(first)).toBe(5_000 - PRICE);
    expect((await chargeOf(assignmentId))[0]).toMatchObject({ status: "posted" });
    expect(await problems()).toEqual([]);
  });
});

describe("every way a lead can end without being kept refunds it, once", () => {
  async function setup() {
    const id = await client({ mode: "prepaid", credit: 10_000 });
    const held = await assigned(id);
    expect(await wallet(id)).toBe(10_000 - PRICE);
    return { id, ...held };
  }
  const refundsOf = async (assignmentId: string) => (await env.t.admin.selectFrom("credit_ledger").selectAll().where("assignment_id", "=", assignmentId).where("entry_type", "=", "refund").execute());

  async function expectRefundedOnce(id: string, assignmentId: string) {
    expect(await wallet(id)).toBe(10_000);
    const refunds = await refundsOf(assignmentId);
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0]!.amount_pence)).toBe(PRICE);
    expect(refunds[0]!.idempotency_key).toBe(`reverse:${assignmentId}`);
    const [charge] = await chargeOf(assignmentId);
    expect(charge).toMatchObject({ status: "reversed" });
    expect(Number(charge!.reversal_ledger_entry_id)).toBe(Number(refunds[0]!.id));
    expect(await problems()).toEqual([]);
  }

  it("taken back by staff", async () => {
    const { id, assignmentId } = await setup();
    await env.s.assignments.cancel({ operator: env.owner, assignmentId, reason: "no_response", requestId: rid() });
    await expectRefundedOnce(id, assignmentId);
  });

  it("declined by the business", async () => {
    const { id, assignmentId } = await setup();
    const person = await env.t.admin.insertInto("client_users").values({ client_id: id, email: `d-${crypto.randomUUID().slice(0, 6)}@x.example`, name: "D" }).returning("id").executeTakeFirstOrThrow();
    const session: ClientSession = { sessionId: crypto.randomUUID(), userId: person.id, clientId: id, clientName: "B", name: "D", email: "d@x.example", role: "owner" };
    expect(await portal.decline(session, assignmentId, "too_busy", rid())).toEqual({ ok: true });
    await expectRefundedOnce(id, assignmentId);
  });

  it("not delivered to the business", async () => {
    const { id, assignmentId, leadId } = await setup();
    await endAs(assignmentId, leadId, "delivery_failed");
    await expectRefundedOnce(id, assignmentId);
  });

  it("expired", async () => {
    const { id, assignmentId, leadId } = await setup();
    await endAs(assignmentId, leadId, "expired");
    await expectRefundedOnce(id, assignmentId);
  });

  it("refunded after a dispute", async () => {
    const { id, assignmentId, leadId } = await setup();
    await env.t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'system', true), set_config('app.reason', 'test', true), set_config('app.request_id', 'test', true)`.execute(trx);
      await sql`update lead_assignments set status = 'notified' where id = ${assignmentId}`.execute(trx);
      await sql`update lead_assignments set status = 'disputed' where id = ${assignmentId}`.execute(trx);
      await sql`update lead_assignments set status = 'refunded' where id = ${assignmentId}`.execute(trx);
      await sql`update leads set status = 'new' where id = ${leadId}`.execute(trx);
    });
    await expectRefundedOnce(id, assignmentId);
  });

  it("keeping it (accepting) refunds nothing, and neither does moving through notified or disputed and back", async () => {
    const { id, assignmentId } = await setup();
    await env.t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'system', true), set_config('app.reason', 'test', true)`.execute(trx);
      for (const status of ["notified", "accepted", "disputed", "accepted"]) await sql`update lead_assignments set status = ${status}::assignment_status where id = ${assignmentId}`.execute(trx);
    });
    expect(await wallet(id)).toBe(10_000 - PRICE);
    expect(await refundsOf(assignmentId)).toHaveLength(0);
    expect((await chargeOf(assignmentId))[0]).toMatchObject({ status: "posted" });
  });

  it("RACE: staff taking it back and the business declining it at the same instant refund ONE time", async () => {
    const id = await client({ mode: "prepaid", credit: 100_000 });
    const person = await env.t.admin.insertInto("client_users").values({ client_id: id, email: `r-${crypto.randomUUID().slice(0, 6)}@x.example`, name: "R" }).returning("id").executeTakeFirstOrThrow();
    const session: ClientSession = { sessionId: crypto.randomUUID(), userId: person.id, clientId: id, clientName: "B", name: "R", email: "r@x.example", role: "owner" };
    for (let round = 0; round < 10; round += 1) {
      const { assignmentId } = await assigned(id);
      await Promise.all([
        env.s.assignments.cancel({ operator: env.owner, assignmentId, reason: "no_response", requestId: rid() }),
        portal.decline(session, assignmentId, "too_busy", rid()),
        env.s.assignments.cancel({ operator: env.owner, assignmentId, reason: "no_response", requestId: rid() }),
      ]);
      expect(await refundsOf(assignmentId), `round ${round}`).toHaveLength(1);
    }
    expect(await wallet(id)).toBe(100_000);
    expect(await problems()).toEqual([]);
  });
});

describe("credit can never be overdrawn, however many leads are assigned at once", () => {
  it("20 simultaneous assignments against credit for exactly 5: exactly 5 succeed, 15 are refused, the balance ends at zero", async () => {
    const id = await client({ mode: "prepaid", credit: PRICE * 5 });
    const leads = await Promise.all(Array.from({ length: 20 }, () => lead()));
    const results = await Promise.all(leads.map((l) => env.s.assignments.assign({ operator: env.owner, leadId: l.id, clientId: id, requestId: rid() })));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.code === "insufficient_credit")).toHaveLength(15);
    expect(results.every((r) => r.ok || r.code === "insufficient_credit")).toBe(true); // typed, never a thrown error
    expect(await wallet(id)).toBe(0);
    const entries = await ledger(id);
    expect(entries.filter((e) => e.entry_type === "lead_charge")).toHaveLength(5);
    expect(entries.every((e) => Number(e.balance_after_pence) >= 0)).toBe(true);
    expect(await env.t.admin.selectFrom("lead_charges").select("id").where("client_id", "=", id).execute()).toHaveLength(5);
    expect(await problems()).toEqual([]);
  });

  it("assignments racing a staff correction that removes credit: the balance never goes below zero and nothing disagrees", async () => {
    for (let round = 0; round < 6; round += 1) {
      const id = await client({ mode: "prepaid", credit: PRICE * 3 });
      const leads = await Promise.all(Array.from({ length: 6 }, () => lead()));
      const outcomes = await Promise.all([
        ...leads.map((l) => env.s.assignments.assign({ operator: env.owner, leadId: l.id, clientId: id, requestId: rid() })),
        billing.post({ operator: env.owner, clientId: id, postingId: crypto.randomUUID(), fields: { kind: "adjustment", reason: "error_correction", amount: "-50" }, requestId: rid() }),
        billing.post({ operator: env.owner, clientId: id, postingId: crypto.randomUUID(), fields: { kind: "grant", reason: "goodwill", amount: "20" }, requestId: rid() }),
      ]);
      expect(outcomes.every((o) => o.ok || ["insufficient_credit"].includes(o.code))).toBe(true);
      expect(await wallet(id)).toBeGreaterThanOrEqual(0);
    }
    expect(await problems()).toEqual([]);
  });

  it("the same lead assigned twice at once is still one lead, one charge", async () => {
    const id = await client({ mode: "prepaid", credit: PRICE * 3 });
    const other = await client({ mode: "prepaid", credit: PRICE * 3 });
    const l = await lead();
    const results = await Promise.all([id, other, id, other].map((clientId) => env.s.assignments.assign({ operator: env.owner, leadId: l.id, clientId, requestId: rid() })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const charges = await env.t.admin.selectFrom("lead_charges as c").innerJoin("lead_assignments as a", "a.id", "c.assignment_id").select("c.id").where("a.lead_id", "=", l.id).execute();
    expect(charges).toHaveLength(1);
    expect((await wallet(id)) + (await wallet(other))).toBe(PRICE * 6 - PRICE);
    expect(await problems()).toEqual([]);
  });
});

describe("the router and credit", () => {
  it("skips a business that cannot pay, offers the lead to the next, and uses a business again once it has credit", async () => {
    const own = await buildRouting({ price: PRICE });
    try {
      const ownBilling = createBillingService({ db: own.t.db, logger: silent });
      const broke = await own.s.activeClient(own.owner, { name: "Broke" });
      await own.t.admin.updateTable("clients").set({ priority: 1 }).where("id", "=", broke).execute();
      await ownBilling.setMode({ operator: own.owner, clientId: broke, mode: "prepaid", requestId: rid() });
      const fine = await own.s.activeClient(own.owner, { name: "Fine" });
      await own.t.admin.updateTable("clients").set({ priority: 50 }).where("id", "=", fine).execute();
      await own.turnOn();

      const first = await insertRawLead(own.t.admin, {});
      expect(await own.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: first.id, clientId: fine });
      expect(JSON.stringify((await own.runsOf(first.id)).at(-1)!.candidates)).toContain("insufficient_credit");

      await ownBilling.post({ operator: own.owner, clientId: broke, postingId: crypto.randomUUID(), fields: { kind: "top_up", reason: "bank_transfer", amount: "35" }, requestId: rid() });
      const second = await insertRawLead(own.t.admin, {});
      expect(await own.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: second.id, clientId: broke });
      expect(Number((await own.t.admin.selectFrom("client_wallets").select("balance_pence").where("client_id", "=", broke).executeTakeFirstOrThrow()).balance_pence)).toBe(0);

      const third = await insertRawLead(own.t.admin, {});
      expect(await own.routing.routeNext()).toMatchObject({ outcome: "assigned", leadId: third.id, clientId: fine }); // broke is broke again
    } finally {
      await own.destroy();
    }
  });

  it("the router WAITS for a business's wallet lock before choosing it, so the balance it read cannot be spent underneath it", async () => {
    const own = await buildRouting({ price: PRICE });
    try {
      const ownBilling = createBillingService({ db: own.t.db, logger: silent });
      const only = await own.s.activeClient(own.owner);
      await ownBilling.setMode({ operator: own.owner, clientId: only, mode: "prepaid", requestId: rid() });
      await ownBilling.post({ operator: own.owner, clientId: only, postingId: crypto.randomUUID(), fields: { kind: "top_up", reason: "bank_transfer", amount: "35" }, requestId: rid() });
      await own.turnOn();
      await insertRawLead(own.t.admin, {});
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => { locked = resolve; });
      const holder = own.t.db.transaction().execute(async (trx) => {
        await sql`select lock_wallet_balance(${only}::uuid)`.execute(trx);
        locked();
        await hold;
      });
      await holding;
      let settled = false;
      const routing = own.routing.routeNext().then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled, "routing should be waiting for the wallet lock").toBe(false);
      release();
      await holder;
      expect(await routing).toMatchObject({ outcome: "assigned", clientId: only });
    } finally {
      await own.destroy();
    }
  });

  it("credit being spent in a transaction that has not committed yet cannot make the router pick a business it cannot pay: it waits, then chooses the next", async () => {
    const own = await buildRouting({ price: PRICE });
    try {
      const ownBilling = createBillingService({ db: own.t.db, logger: silent });
      const top = await own.s.activeClient(own.owner, { name: "Top" });
      await own.t.admin.updateTable("clients").set({ priority: 1 }).where("id", "=", top).execute();
      await ownBilling.setMode({ operator: own.owner, clientId: top, mode: "prepaid", requestId: rid() });
      await ownBilling.post({ operator: own.owner, clientId: top, postingId: crypto.randomUUID(), fields: { kind: "top_up", reason: "bank_transfer", amount: "35" }, requestId: rid() });
      const spare = await own.s.activeClient(own.owner, { name: "Spare" });
      await own.t.admin.updateTable("clients").set({ priority: 50 }).where("id", "=", spare).execute();
      await own.turnOn();
      const l = await insertRawLead(own.t.admin, {});

      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let spent!: () => void;
      const spending = new Promise<void>((resolve) => { spent = resolve; });
      // Somebody removes all of Top's credit and has not committed yet. The router reads Top as able to pay (the change is invisible to it),
      // so ONLY the wallet lock stops it choosing Top and then failing at the charge.
      const holder = own.t.db.transaction().execute(async (trx) => {
        await sql`select post_credit(${top}::uuid, 'adjustment'::ledger_entry_type, ${-PRICE}::bigint, 'error_correction', ${own.owner.id}::uuid, ${`k-${crypto.randomUUID()}`})`.execute(trx);
        spent();
        await hold;
      });
      await spending;
      let settled = false;
      const routing = own.routing.routeNext().then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled, "routing should be waiting for the wallet").toBe(false);
      release();
      await holder;
      expect(await routing).toMatchObject({ outcome: "assigned", leadId: l.id, clientId: spare });
      expect(await ownBilling.problems()).toEqual([]);
    } finally {
      await own.destroy();
    }
  });

  it("when the only business cannot pay, the lead is parked for a person, not lost and not charged", async () => {
    const own = await buildRouting({ price: PRICE });
    try {
      const ownBilling = createBillingService({ db: own.t.db, logger: silent });
      const only = await own.s.activeClient(own.owner);
      await ownBilling.setMode({ operator: own.owner, clientId: only, mode: "prepaid", requestId: rid() });
      await own.turnOn();
      const l = await insertRawLead(own.t.admin, {});
      expect(await own.routing.routeNext()).toMatchObject({ outcome: "no_candidates", leadId: l.id });
      expect((await own.leadRow(l.id)).status).toBe("unroutable");
      expect(await ownBilling.problems()).toEqual([]);
    } finally {
      await own.destroy();
    }
  });

  it("RACE: a person spending the last of a business's credit while the router is choosing it never produces an error or a double spend", async () => {
    for (let round = 0; round < 8; round += 1) {
      const own = await buildRouting({ price: PRICE });
      try {
        const ownBilling = createBillingService({ db: own.t.db, logger: silent });
        const top = await own.s.activeClient(own.owner, { name: "Top" });
        await own.t.admin.updateTable("clients").set({ priority: 1 }).where("id", "=", top).execute();
        await ownBilling.setMode({ operator: own.owner, clientId: top, mode: "prepaid", requestId: rid() });
        await ownBilling.post({ operator: own.owner, clientId: top, postingId: crypto.randomUUID(), fields: { kind: "top_up", reason: "bank_transfer", amount: "35" }, requestId: rid() }); // exactly one lead
        const spare = await own.s.activeClient(own.owner, { name: "Spare" });
        await own.t.admin.updateTable("clients").set({ priority: 50 }).where("id", "=", spare).execute();
        await own.turnOn();
        const routed = await insertRawLead(own.t.admin, {});
        const manual = await insertRawLead(own.t.admin, {});
        // Make the manual lead one the router will not take: a person has "handled" it.
        await own.t.admin.insertInto("lead_events").values({ lead_id: manual.id, type: "lead.handled", actor_type: "system", payload: "{}" }).execute();

        const [routing, byHand] = await Promise.all([
          own.routing.routeNext(),
          own.s.assignments.assign({ operator: own.owner, leadId: manual.id, clientId: top, requestId: rid() }),
        ]);
        expect(routing?.outcome, `round ${round}`).toBe("assigned"); // never an error
        const toTop = [routing?.outcome === "assigned" && routing.clientId === top, byHand.ok].filter(Boolean).length;
        expect(toTop, `round ${round}: credit for one lead went to ${toTop}`).toBe(1);
        const balance = Number((await own.t.admin.selectFrom("client_wallets").select("balance_pence").where("client_id", "=", top).executeTakeFirstOrThrow()).balance_pence);
        expect(balance).toBe(0);
        expect(await ownBilling.problems()).toEqual([]);
        void routed;
      } finally {
        await own.destroy();
      }
    }
  });
});

describe("only the database moves money", () => {
  it("the application role can read wallets, the ledger and charges, but cannot write any of them", async () => {
    const id = await client({ mode: "prepaid", credit: 5_000 });
    const { assignmentId } = await assigned(id);
    expect(await env.t.db.selectFrom("client_wallets").select("balance_pence").where("client_id", "=", id).execute()).toHaveLength(1);
    const denied = (work: () => Promise<unknown>) => expect(work()).rejects.toThrow(/permission denied/);
    await denied(() => env.t.db.updateTable("client_wallets").set({ balance_pence: 999_999 }).where("client_id", "=", id).execute());
    await denied(() => env.t.db.insertInto("client_wallets").values({ client_id: crypto.randomUUID(), balance_pence: 1 }).execute());
    await denied(() => sql`insert into credit_ledger (client_id, entry_type, amount_pence, balance_after_pence, idempotency_key) values (${id}, 'grant', 100, 100, 'forged')`.execute(env.t.db));
    await denied(() => sql`update credit_ledger set amount_pence = 1 where client_id = ${id}`.execute(env.t.db));
    await denied(() => sql`delete from credit_ledger where client_id = ${id}`.execute(env.t.db));
    await denied(() => sql`update lead_charges set amount_pence = 0 where assignment_id = ${assignmentId}`.execute(env.t.db));
    await denied(() => sql`delete from lead_charges where assignment_id = ${assignmentId}`.execute(env.t.db));
    await denied(() => sql`insert into lead_charges (assignment_id, client_id, amount_pence, source) values (${assignmentId}, ${id}, 0, 'invoice')`.execute(env.t.db));
    await denied(() => sql`select charge_new_assignment()`.execute(env.t.db));
    expect(await wallet(id)).toBe(5_000 - PRICE);
  });

  it("post_credit refuses to post a charge or refund, or to post without a named person", async () => {
    const id = await client({ mode: "prepaid" });
    const call = (type: string, amount: number, operator: string | null) => sql`select post_credit(${id}::uuid, ${type}::ledger_entry_type, ${amount}::bigint, 'goodwill', ${operator}::uuid, ${`k-${crypto.randomUUID()}`})`.execute(env.t.db);
    await expect(call("lead_charge", -100, env.owner.id)).rejects.toMatchObject({ code: "23514" });
    await expect(call("refund", 100, env.owner.id)).rejects.toMatchObject({ code: "23514" });
    await expect(call("grant", 100, null)).rejects.toMatchObject({ code: "23514" });
    // Isolate each rule: fund the business first, so "would overdraw" cannot be the reason a wrong-signed or wrong-typed entry is refused.
    await credit(id, 5_000);
    await expect(call("grant", -100, env.owner.id)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("credit_ledger_sign_chk") }); // sign must match the type
    await expect(call("top_up", -100, env.owner.id)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("credit_ledger_sign_chk") });
    await expect(call("expiry", -100, env.owner.id)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("cannot post a expiry") }); // not a door staff may use
    await expect(call("lead_charge", -100, env.owner.id)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("cannot post a lead_charge") });
    await expect(call("refund", 100, env.owner.id)).rejects.toMatchObject({ code: "23514", message: expect.stringContaining("cannot post a refund") });
    expect(await wallet(id)).toBe(5_000);
  });

  it("holding a business's wallet lock makes a charge on it WAIT (nobody can spend credit that is being looked at), then it goes through", async () => {
    const id = await client({ mode: "prepaid", credit: PRICE * 2 });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const holder = env.t.db.transaction().execute(async (trx) => {
      await sql`select lock_wallet_balance(${id}::uuid)`.execute(trx);
      locked();
      await hold;
    });
    await holding;
    let settled = false;
    const pending = assign(id).then((r) => { settled = true; return r; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled, "the charge should be waiting for the wallet lock").toBe(false);
    release();
    await holder;
    expect((await pending).result.ok).toBe(true);
    expect(await wallet(id)).toBe(PRICE);
  });

  it("post_credit itself is idempotent on its key: sequentially and at the same instant it posts once and returns the same entry", async () => {
    const id = await client({ mode: "prepaid" });
    const key = `k-${crypto.randomUUID()}`;
    const call = () => sql<{ id: string }>`select post_credit(${id}::uuid, 'grant'::ledger_entry_type, 700::bigint, 'goodwill', ${env.owner.id}::uuid, ${key}) as id`.execute(env.t.db);
    const first = await call();
    const second = await call();
    expect(second.rows[0]!.id).toBe(first.rows[0]!.id);
    const burst = await Promise.all(Array.from({ length: 12 }, () => call()));
    expect(new Set(burst.map((r) => r.rows[0]!.id))).toEqual(new Set([first.rows[0]!.id]));
    expect(await wallet(id)).toBe(700);
    expect(await ledger(id)).toHaveLength(1);
    const other = `k-${crypto.randomUUID()}`;
    const racing = await Promise.all(Array.from({ length: 12 }, () => sql<{ id: string }>`select post_credit(${id}::uuid, 'grant'::ledger_entry_type, 100::bigint, 'goodwill', ${env.owner.id}::uuid, ${other}) as id`.execute(env.t.db)));
    expect(new Set(racing.map((r) => r.rows[0]!.id)).size).toBe(1);
    expect(await wallet(id)).toBe(800);
  });

  it("even the database owner cannot edit the ledger, and a charge can only be reversed, once", async () => {
    const id = await client({ mode: "prepaid", credit: 5_000 });
    const { assignmentId } = await assigned(id);
    await expect(env.t.admin.updateTable("credit_ledger").set({ amount_pence: 1 }).where("client_id", "=", id).execute()).rejects.toMatchObject({ code: "23514" });
    await expect(env.t.admin.deleteFrom("credit_ledger").where("client_id", "=", id).execute()).rejects.toMatchObject({ code: "23514" });
    await expect(env.t.admin.updateTable("lead_charges").set({ amount_pence: 0 }).where("assignment_id", "=", assignmentId).execute()).rejects.toMatchObject({ code: "23514" });
    await expect(env.t.admin.deleteFrom("lead_charges").where("assignment_id", "=", assignmentId).execute()).rejects.toMatchObject({ code: "23514" });
    await expect(sql`insert into lead_charges (assignment_id, client_id, amount_pence, source) values (${assignmentId}, ${id}, 0, 'invoice')`.execute(env.t.admin)).rejects.toMatchObject({ code: "23505" }); // one charge per assignment
  });

  it("a ledger entry's idempotency key is unique", async () => {
    const id = await client({ mode: "prepaid", credit: 1_000 });
    const [entry] = await ledger(id);
    await expect(sql`insert into credit_ledger (client_id, entry_type, amount_pence, balance_after_pence, idempotency_key, reason) values (${id}, 'grant', 5, 5, ${entry!.idempotency_key}, 'goodwill')`.execute(env.t.admin)).rejects.toMatchObject({ code: "23505" });
  });
});

describe("staff adding and removing credit", () => {
  const post = (clientId: string, fields: Record<string, string>, postingId: string = crypto.randomUUID()) => billing.post({ operator: env.owner, clientId, postingId, fields, requestId: rid() });

  it("records the kind, the reason, the person and the amount, and audits it with no personal data", async () => {
    const id = await client({ mode: "prepaid" });
    const result = await post(id, { kind: "top_up", reason: "bank_transfer", amount: "£1,250.50" });
    expect(result).toEqual({ ok: true, replay: false, balancePence: 125_050 });
    const [entry] = await ledger(id);
    expect(entry).toMatchObject({ entry_type: "top_up", reason: "bank_transfer", created_by: env.owner.id });
    expect(Number(entry!.amount_pence)).toBe(125_050);
    const audit = await env.t.admin.selectFrom("audit_logs").selectAll().where("action", "=", "billing.credit_posted").where("entity_id", "=", id).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ actor_id: env.owner.id, reason: "bank_transfer", after: { kind: "top_up", amount_pence: 125_050 } });
  });

  it("posting the same form twice posts ONCE and says so; ten at once still post once, audited once", async () => {
    const id = await client({ mode: "prepaid" });
    const postingId = crypto.randomUUID();
    expect(await post(id, { kind: "grant", reason: "goodwill", amount: "10" }, postingId)).toMatchObject({ ok: true, replay: false });
    expect(await post(id, { kind: "grant", reason: "goodwill", amount: "10" }, postingId)).toMatchObject({ ok: true, replay: true, balancePence: 1_000 });
    const burst = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 10 }, () => post(id, { kind: "grant", reason: "goodwill", amount: "5" }, burst)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.replay)).toHaveLength(1);
    expect(await wallet(id)).toBe(1_500);
    expect((await ledger(id))).toHaveLength(2);
    expect(await env.t.admin.selectFrom("audit_logs").select("id").where("action", "=", "billing.credit_posted").where("entity_id", "=", id).execute()).toHaveLength(2);
  });

  it("refuses nonsense: unknown kinds and reasons, reasons from the wrong kind, bad amounts, signs, zero, and too much", async () => {
    const id = await client({ mode: "prepaid" });
    const bad: Array<Record<string, string>> = [
      {}, { kind: "lead_charge", reason: "goodwill", amount: "5" }, { kind: "grant", reason: "because", amount: "5" }, { kind: "grant", reason: "bank_transfer", amount: "5" },
      { kind: "grant", reason: "goodwill", amount: "-5" }, { kind: "top_up", reason: "bank_transfer", amount: "0" }, { kind: "grant", reason: "goodwill", amount: "1e3" },
      { kind: "grant", reason: "goodwill", amount: "10000.01" }, { kind: "grant", reason: "goodwill", amount: "free" }, { kind: "adjustment", reason: "error_correction", amount: "0" },
      { kind: "grant", reason: "goodwill; drop table credit_ledger", amount: "5" },
    ];
    for (const fields of bad) expect(await post(id, fields), JSON.stringify(fields)).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await post(id, { kind: "grant", reason: "goodwill", amount: "10000" })).toMatchObject({ ok: true });
    expect(await billing.post({ operator: env.owner, clientId: id, postingId: "not-an-id", fields: { kind: "grant", reason: "goodwill", amount: "5" }, requestId: rid() })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await post("00000000-0000-4000-8000-000000000000", { kind: "grant", reason: "goodwill", amount: "5" })).toEqual({ ok: false, code: "not_found" });
  });

  it("a correction cannot take the balance below zero (the database refuses it), and leaves no trace", async () => {
    const id = await client({ mode: "prepaid", credit: 1_000 });
    const before = (await ledger(id)).length;
    expect(await post(id, { kind: "adjustment", reason: "error_correction", amount: "-10.01" })).toEqual({ ok: false, code: "insufficient_credit" });
    expect(await post(id, { kind: "adjustment", reason: "error_correction", amount: "-10" })).toMatchObject({ ok: true, balancePence: 0 });
    expect((await ledger(id)).length).toBe(before + 1);
    expect(await problems()).toEqual([]);
  });

  it("switching how a business pays is audited, refuses repeats and unknown modes, and does not touch charges already made", async () => {
    const id = await client();
    const { assignmentId } = await assigned(id); // invoiced
    expect(await billing.setMode({ operator: env.owner, clientId: id, mode: "prepaid", requestId: rid() })).toEqual({ ok: true });
    expect(await billing.setMode({ operator: env.owner, clientId: id, mode: "prepaid", requestId: rid() })).toEqual({ ok: false, code: "already_in_state" });
    expect(await billing.setMode({ operator: env.owner, clientId: id, mode: "free", requestId: rid() })).toEqual({ ok: false, code: "invalid_mode" });
    expect(await billing.setMode({ operator: env.owner, clientId: "00000000-0000-4000-8000-000000000000", mode: "prepaid", requestId: rid() })).toEqual({ ok: false, code: "not_found" });
    expect((await chargeOf(assignmentId))[0]).toMatchObject({ source: "invoice", status: "posted" });
    // Ending the old invoiced lead after the switch still reverses the invoice charge and moves no credit.
    await env.s.assignments.cancel({ operator: env.owner, assignmentId, reason: "no_response", requestId: rid() });
    expect(await wallet(id)).toBe(0);
    expect(await ledger(id)).toEqual([]);
    const audit = await env.t.admin.selectFrom("audit_logs").select(["before", "after"]).where("action", "=", "billing.mode_changed").where("entity_id", "=", id).executeTakeFirstOrThrow();
    expect(audit).toMatchObject({ before: { billing_mode: "invoice" }, after: { billing_mode: "prepaid" } });
  });

  it("a prepaid lead still refunds to credit after the business is switched back to invoice", async () => {
    const id = await client({ mode: "prepaid", credit: 5_000 });
    const { assignmentId } = await assigned(id);
    await billing.setMode({ operator: env.owner, clientId: id, mode: "invoice", requestId: rid() });
    await env.s.assignments.cancel({ operator: env.owner, assignmentId, reason: "no_response", requestId: rid() });
    expect(await wallet(id)).toBe(5_000);
    expect(await problems()).toEqual([]);
  });
});

describe("what a business sees of its own money", () => {
  it("its own balance, ledger and charges, never another's; and it cannot change any of it", async () => {
    const mine = await client({ mode: "prepaid", credit: 8_000 });
    const theirs = await client({ mode: "prepaid", credit: 9_000 });
    await assigned(mine);
    await assigned(theirs);
    const person = await env.t.admin.insertInto("client_users").values({ client_id: mine, email: `m-${crypto.randomUUID().slice(0, 6)}@x.example`, name: "M" }).returning("id").executeTakeFirstOrThrow();
    const session: ClientSession = { sessionId: crypto.randomUUID(), userId: person.id, clientId: mine, clientName: "Mine", name: "M", email: "m@x.example", role: "owner" };

    const view = await billing.forBusiness(session);
    expect(view).toMatchObject({ mode: "prepaid", balancePence: 8_000 - PRICE, thisMonth: { leads: 1, totalPence: PRICE } });
    expect(view!.ledger.map((e) => e.type)).toEqual(["lead_charge", "grant"]);
    expect(view!.charges).toHaveLength(1);
    expect(view!.ledger.every((e) => e.by === null)).toBe(true); // staff names are not shown to the business

    const { withClientScope } = await import("../../src/lib/db/client-scope");
    const seen = await withClientScope(env.t.db, mine, async (scoped) => ({
      wallets: await sql<{ client_id: string }>`select client_id from client_wallets`.execute(scoped),
      ledger: await sql<{ client_id: string }>`select client_id from credit_ledger`.execute(scoped),
      charges: await sql<{ client_id: string }>`select client_id from lead_charges`.execute(scoped),
    }));
    for (const rows of Object.values(seen)) expect(new Set(rows.rows.map((r) => r.client_id))).toEqual(new Set([mine]));
    await expect(withClientScope(env.t.db, mine, (scoped) => sql`update client_wallets set balance_pence = 1_000_000 where client_id = ${mine}`.execute(scoped))).rejects.toThrow(/permission denied/);
  });
});

describe("reconciliation finds real problems (it can fail)", () => {
  /** Breaks something inside a transaction that is always rolled back, with the guard triggers off, and returns what the view reports. */
  async function withBreakage(statements: Array<ReturnType<typeof sql>>): Promise<Array<{ client_id: string; problem: string }>> {
    let found: Array<{ client_id: string; problem: string }> = [];
    await env.t.admin.transaction().execute(async (trx) => {
      await sql`set local session_replication_role = replica`.execute(trx); // switches user triggers off for this transaction only
      for (const statement of statements) await statement.execute(trx);
      await sql`set local session_replication_role = origin`.execute(trx);
      found = (await sql<{ client_id: string; problem: string }>`select client_id, problem from v_money_problems`.execute(trx)).rows;
      throw new Error("rollback");
    }).catch((error: Error) => { if (error.message !== "rollback") throw error; });
    return found;
  }

  it("is clean before and after (the breakage above leaves nothing behind)", async () => {
    expect(await problems()).toEqual([]);
  });

  it("a wallet that does not equal its ledger", async () => {
    const id = await client({ mode: "prepaid", credit: 5_000 });
    const found = await withBreakage([sql`update client_wallets set balance_pence = balance_pence + 1 where client_id = ${id}`]);
    expect(found.filter((p) => p.client_id === id).map((p) => p.problem).sort()).toEqual(["wallet_differs_from_last_balance_after", "wallet_differs_from_ledger_sum"]);
    expect(await problems()).toEqual([]);
  });

  it("a charge whose amount is not the assignment's price", async () => {
    const id = await client();
    const { assignmentId } = await assigned(id);
    const found = await withBreakage([sql`update lead_charges set amount_pence = 1 where assignment_id = ${assignmentId}`]);
    expect(found).toContainEqual({ client_id: id, problem: "charge_differs_from_assignment_price" });
  });

  it("a prepaid charge that lost its ledger entry's amount", async () => {
    const id = await client({ mode: "prepaid", credit: 5_000 });
    const { assignmentId } = await assigned(id);
    const found = await withBreakage([sql`update credit_ledger set amount_pence = -1 where assignment_id = ${assignmentId} and entry_type = 'lead_charge'`]);
    expect(found.map((p) => p.problem)).toContain("prepaid_charge_without_matching_ledger_entry");
  });

  it("a lead a business holds with no live charge, and an ended lead still being charged for", async () => {
    const id = await client();
    const live = await assigned(id);
    const ended = await assigned(id);
    await env.s.assignments.cancel({ operator: env.owner, assignmentId: ended.assignmentId, reason: "no_response", requestId: rid() });
    const found = await withBreakage([
      sql`update lead_charges set status = 'reversed', reversed_at = now() where assignment_id = ${live.assignmentId}`,
      sql`update lead_charges set status = 'posted', reversed_at = null where assignment_id = ${ended.assignmentId}`,
    ]);
    expect(found.map((p) => p.problem)).toEqual(expect.arrayContaining(["live_assignment_without_posted_charge", "ended_assignment_with_posted_charge"]));
  });

  it("a ledger charge that belongs to no charge, and a reversed charge with no refund", async () => {
    const id = await client({ mode: "prepaid", credit: 9_000 });
    const a = await assigned(id);
    const b = await assigned(id);
    await env.s.assignments.cancel({ operator: env.owner, assignmentId: b.assignmentId, reason: "no_response", requestId: rid() });
    const found = await withBreakage([
      sql`delete from lead_charges where assignment_id = ${a.assignmentId}`,
      sql`update lead_charges set reversal_ledger_entry_id = (select id from credit_ledger where entry_type = 'grant' and client_id = ${id}) where assignment_id = ${b.assignmentId}`,
    ]);
    expect(found.map((p) => p.problem)).toEqual(expect.arrayContaining(["charge_entry_without_charge", "reversed_charge_without_matching_refund"]));
  });

  it("the service reports the count, and /api/pipeline's money check goes red while the money disagrees and green again after", async () => {
    const { getBillingHealth } = await import("../../src/modules/billing");
    const id = await client({ mode: "prepaid", credit: 1_000 });
    expect(await billing.reconcile()).toBe(0);
    expect(await getBillingHealth(env.t.db)).toEqual({ ok: true, problems: [] });
    await env.t.admin.updateTable("client_wallets").set({ balance_pence: 2_000 }).where("client_id", "=", id).execute(); // someone tampers
    expect(await billing.reconcile()).toBeGreaterThan(0);
    expect(await getBillingHealth(env.t.db)).toEqual({ ok: false, problems: ["money_does_not_add_up"] });
    await env.t.admin.updateTable("client_wallets").set({ balance_pence: 1_000 }).where("client_id", "=", id).execute();
    expect(await getBillingHealth(env.t.db)).toEqual({ ok: true, problems: [] });
  });
});

describe("under load: random activity across several businesses at once", () => {
  it("ends with every wallet equal to its ledger, no balance below zero, one charge per assignment, and nothing the reconciliation objects to", async () => {
    const clients = await Promise.all([
      client({ mode: "prepaid", credit: PRICE * 4 }), client({ mode: "prepaid", credit: PRICE * 2 }), client({ mode: "prepaid" }), client({ mode: "invoice" }), client({ mode: "prepaid", credit: PRICE * 6 }),
    ]);
    const people = await Promise.all(clients.map(async (clientId) => {
      const row = await env.t.admin.insertInto("client_users").values({ client_id: clientId, email: `l-${crypto.randomUUID().slice(0, 8)}@x.example`, name: "L" }).returning("id").executeTakeFirstOrThrow();
      return { sessionId: crypto.randomUUID(), userId: row.id, clientId, clientName: "L", name: "L", email: "l@x.example", role: "owner" } as ClientSession;
    }));
    const live: Array<{ assignmentId: string; clientIndex: number }> = [];
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;

    for (let wave = 0; wave < 14; wave += 1) {
      const tasks: Array<Promise<unknown>> = [];
      for (let n = 0; n < 8; n += 1) {
        const pickIndex = Math.floor(random() * clients.length);
        const roll = random();
        if (roll < 0.5) {
          tasks.push(lead().then((l) => env.s.assignments.assign({ operator: env.owner, leadId: l.id, clientId: clients[pickIndex]!, requestId: rid() })).then((r) => { if (r.ok) live.push({ assignmentId: r.assignmentId, clientIndex: pickIndex }); }));
        } else if (roll < 0.65 && live.length > 0) {
          const target = live.splice(Math.floor(random() * live.length), 1)[0]!;
          tasks.push(env.s.assignments.cancel({ operator: env.owner, assignmentId: target.assignmentId, reason: "no_response", requestId: rid() }));
        } else if (roll < 0.8 && live.length > 0) {
          const target = live.splice(Math.floor(random() * live.length), 1)[0]!;
          tasks.push(portal.decline(people[target.clientIndex]!, target.assignmentId, "too_busy", rid()));
        } else if (roll < 0.9) {
          tasks.push(billing.post({ operator: env.owner, clientId: clients[pickIndex]!, postingId: crypto.randomUUID(), fields: { kind: "grant", reason: "goodwill", amount: "35" }, requestId: rid() }));
        } else {
          tasks.push(billing.post({ operator: env.owner, clientId: clients[pickIndex]!, postingId: crypto.randomUUID(), fields: { kind: "adjustment", reason: "error_correction", amount: "-20" }, requestId: rid() }));
        }
      }
      const settled = await Promise.allSettled(tasks);
      expect(settled.filter((s) => s.status === "rejected"), `wave ${wave}`).toEqual([]); // typed failures only: nothing may throw
    }

    expect(await problems()).toEqual([]);
    const negatives = await sql`select client_id from client_wallets where balance_pence < 0`.execute(env.t.admin);
    expect(negatives.rows).toEqual([]);
    const duplicates = await sql<{ n: string }>`select count(*) as n from (select assignment_id from lead_charges group by assignment_id having count(*) > 1) d`.execute(env.t.admin);
    expect(Number(duplicates.rows[0]!.n)).toBe(0);
    // Every held assignment has a live charge; every ended one a reversed charge.
    const held = await sql<{ n: string }>`select count(*) as n from lead_assignments a join lead_charges c on c.assignment_id = a.id where a.status in ('reserved','notified','accepted','disputed') and c.status <> 'posted'`.execute(env.t.admin);
    expect(Number(held.rows[0]!.n)).toBe(0);
  }, 120_000);
});
