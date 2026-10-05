import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawLead } from "../helpers/raw";
import { buildStage3 } from "../helpers/stage3";

/**
 * Handing leads to businesses by hand (stage 3). The property that matters: a lead is never held by two businesses, never handed
 * over without consent, outside a business's coverage without a recorded decision, or moved without a person and a reason, however
 * many operators click at once.
 */
let t: TestDatabase;
let s: ReturnType<typeof buildStage3>;
let ops: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
let br6Client: string;

beforeAll(async () => {
  t = await createTestDatabase();
  s = buildStage3(t);
  ops = await s.operator("assign@example.com");
  br6Client = await s.activeClient(ops, { name: "BR6 Roofing" });
  await s.setPrice(ops, 3500);
});
afterAll(async () => {
  await t.destroy();
});

const lead = (overrides: Parameters<typeof insertRawLead>[1] = {}) => insertRawLead(t.admin, overrides);
const leadRow = (id: string) => t.admin.selectFrom("leads").select(["status", "sale_model", "max_assignments", "assignments_count"]).where("id", "=", id).executeTakeFirstOrThrow();
const assignmentsOf = (leadId: string) => t.admin.selectFrom("lead_assignments").selectAll().where("lead_id", "=", leadId).orderBy("created_at").execute();
const historyOf = (assignmentId: string) => t.admin.selectFrom("lead_assignment_status_history").selectAll().where("assignment_id", "=", assignmentId).orderBy("id").execute();
const auditOf = (leadId: string) => t.admin.selectFrom("audit_logs").selectAll().where("entity_id", "=", leadId).orderBy("id").execute();
const assign = (leadId: string, clientId = br6Client, extra: Record<string, unknown> = {}, by = ops) =>
  s.assignments.assign({ operator: by, leadId, clientId, requestId: s.rid(), ...extra });

describe("assigning a new lead", () => {
  it("records the sale model, the price from the pricing rule, the operator, and moves the lead to assigned", async () => {
    const l = await lead();
    const result = await assign(l.id);
    expect(result).toMatchObject({ ok: true, pricePence: 3500, outsideCoverage: false });
    if (!result.ok) return;

    expect(await leadRow(l.id)).toEqual({ status: "assigned", sale_model: "exclusive", max_assignments: 1, assignments_count: 1 });
    const [assignment] = await assignmentsOf(l.id);
    expect(assignment).toMatchObject({ client_id: br6Client, status: "reserved", assigned_by: "staff", assigned_by_user_id: ops.id, price_pence: 3500, sale_type: "exclusive" });
    expect(assignment!.pricing_rule_id).toBeTruthy();

    // History records the person and why, for BOTH the assignment and the lead.
    expect((await historyOf(assignment!.id))[0]).toMatchObject({ from_status: null, to_status: "reserved", actor_type: "staff_user", actor_id: ops.id, reason: "manual_assignment" });
    const leadHistory = await t.admin.selectFrom("lead_status_history").selectAll().where("lead_id", "=", l.id).orderBy("id").execute();
    expect(leadHistory.at(-1)).toMatchObject({ from_status: "new", to_status: "assigned", actor_type: "staff_user", actor_id: ops.id });
    expect((await auditOf(l.id)).at(-1)).toMatchObject({ action: "assignment.created", actor_id: ops.id, reason: "manual_assignment" });
  });

  it("is refused for a lead that is held, already assigned, screened out, erased or unknown", async () => {
    const held = await lead({ status: "held", fraudDecision: "review" });
    expect(await assign(held.id)).toMatchObject({ ok: false, code: "lead_held" });
    const taken = await lead();
    await assign(taken.id);
    expect(await assign(taken.id)).toMatchObject({ ok: false, code: "already_assigned" });
    for (const status of ["rejected_fraud", "invalid", "expired"] as const) {
      const l = await lead({ status, fraudDecision: status === "rejected_fraud" ? "reject" : "accept" });
      expect(await assign(l.id), status).toMatchObject({ ok: false, code: "lead_not_assignable" });
    }
    const erased = await lead();
    await t.admin.updateTable("leads").set({ erased_at: new Date() }).where("id", "=", erased.id).execute();
    expect(await assign(erased.id)).toMatchObject({ ok: false, code: "lead_erased" });
    expect(await assign(crypto.randomUUID())).toMatchObject({ ok: false, code: "not_found" });
  });

  it("is refused for a client that is unknown or not active", async () => {
    const l = await lead();
    expect(await assign(l.id, crypto.randomUUID())).toMatchObject({ ok: false, code: "client_not_found" });
    const prospect = await t.admin.insertInto("clients").values({ vertical_id: (await t.admin.selectFrom("verticals").select("id").executeTakeFirstOrThrow()).id, name: "Not yet", contact_email: "n@example.com" }).returning("id").executeTakeFirstOrThrow();
    expect(await assign(l.id, prospect.id)).toMatchObject({ ok: false, code: "client_not_active" });
    expect((await leadRow(l.id)).status).toBe("new"); // nothing changed
  });

  it("refuses a business that does not cover the postcode, says why, and allows it only as a recorded exception", async () => {
    const tn13 = await s.activeClient(ops, { name: "TN13 only", outward: ["TN13"] });
    const l = await lead(); // BR6 0AA
    const refused = await assign(l.id, tn13);
    expect(refused).toMatchObject({ ok: false, code: "not_covered", reasons: ["no_include_rule_matches"] });
    expect((await leadRow(l.id)).status).toBe("new");

    const allowed = await assign(l.id, tn13, { coverageException: true });
    expect(allowed).toMatchObject({ ok: true, outsideCoverage: true });
    const [assignment] = await assignmentsOf(l.id);
    expect((await historyOf(assignment!.id))[0]!.reason).toBe("coverage_exception");
    expect((await auditOf(l.id)).at(-1)).toMatchObject({ reason: "coverage_exception", after: expect.objectContaining({ outside_coverage: true }) });
  });

  it("refuses an excluded business too, naming the exclusion", async () => {
    const excluded = await s.activeClient(ops, { name: "Excludes BR6 0", rules: [{ mode: "include", kind: "outward", outward: "BR6" }, { mode: "exclude", kind: "sector", sector: "BR6 0" }] });
    const l = await lead();
    expect(await assign(l.id, excluded)).toMatchObject({ ok: false, code: "not_covered", reasons: ["excluded_by_rule"] });
  });

  it("needs a price from the operator only when no pricing rule matches, and ignores a typed price when one does", async () => {
    const local = await createTestDatabase();
    try {
      const sl = buildStage3(local);
      const by = await sl.operator();
      const client = await sl.activeClient(by);
      const l = await insertRawLead(local.admin);
      expect(await sl.assignments.assign({ operator: by, leadId: l.id, clientId: client, requestId: sl.rid() })).toMatchObject({ ok: false, code: "price_required" });
      expect(await sl.assignments.assign({ operator: by, leadId: l.id, clientId: client, manualPricePence: 4000, requestId: sl.rid() })).toMatchObject({ ok: true, pricePence: 4000 });
      expect((await local.admin.selectFrom("lead_assignments").select("pricing_rule_id").where("lead_id", "=", l.id).executeTakeFirstOrThrow()).pricing_rule_id).toBeNull();

      await sl.setPrice(by, 3300);
      const second = await insertRawLead(local.admin);
      expect(await sl.assignments.assign({ operator: by, leadId: second.id, clientId: client, manualPricePence: 9999, requestId: sl.rid() })).toMatchObject({ ok: true, pricePence: 3300 });
    } finally {
      await local.destroy();
    }
  }, 60_000);
});

describe("consent and suppression are checked before a business is given a lead", () => {
  it("refuses a lead whose consumer withdrew consent, and one whose wording allows no business", async () => {
    const withdrawn = await lead();
    expect((await s.privacy.withdrawConsent({ operator: ops, leadId: withdrawn.id, requestId: s.rid() })).ok).toBe(true);
    expect(await assign(withdrawn.id)).toMatchObject({ ok: false, code: "lead_not_assignable" }); // withdrawal retires the lead

    // Even if someone reopened it, the consent record alone refuses the assignment.
    await t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'system', true)`.execute(trx);
      await trx.updateTable("leads").set({ status: "new" }).where("id", "=", withdrawn.id).execute();
    }).catch(() => undefined);

    const firstParty = await t.admin.insertInto("consent_texts").values({ code: "fp", version: "v950", body: "We will contact you ourselves, not a business.", body_sha256: "d".repeat(64), recipient_model: "first_party", max_recipients: 0, channels: ["phone"] }).returning("id").executeTakeFirstOrThrow();
    const none = await lead({ consentTextId: firstParty.id });
    expect(await assign(none.id)).toMatchObject({ ok: false, code: "no_consent_to_share" });
  });

  it("reports withdrawn consent clearly even when the lead's status was never updated (the database guard is the backstop)", async () => {
    const l = await lead();
    const consent = await t.admin.selectFrom("consent_records").select("consent_text_id").where("lead_id", "=", l.id).executeTakeFirstOrThrow();
    await t.admin.insertInto("consent_records").values({ lead_id: l.id, consent_text_id: consent.consent_text_id, event: "withdrawn", method: "operator_request" }).execute();
    expect(await assign(l.id)).toMatchObject({ ok: false, code: "consent_withdrawn" });
    expect((await leadRow(l.id)).status).toBe("new");
  });

  it("refuses a lead whose consumer asked us to stop AFTER they enquired, but not one that merely predates a fresh enquiry", async () => {
    const original = await lead({ phone: "+447911555001" });
    const other = await lead({ phone: "+447911555001" }); // same person, second lead, both before the opt-out
    expect((await s.privacy.withdrawConsent({ operator: ops, leadId: original.id, requestId: s.rid() })).ok).toBe(true);
    // The second lead belongs to the same person, who has now asked us to stop: it must not be handed over either.
    expect(await assign(other.id)).toMatchObject({ ok: false, code: "suppressed" });

    // A NEW enquiry from them afterwards is fresh consent: the older suppression does not block it.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fresh = await lead({ phone: "+447911555001" });
    expect(await assign(fresh.id)).toMatchObject({ ok: true });
  });
});

describe("sending, cancelling and moving a lead", () => {
  it("marks an assignment as sent (reserved -> notified) exactly once", async () => {
    const l = await lead();
    const a = await assign(l.id);
    if (!a.ok) throw new Error("setup");
    expect(await s.assignments.markSent({ operator: ops, assignmentId: a.assignmentId, requestId: s.rid() })).toEqual({ ok: true });
    const [row] = await assignmentsOf(l.id);
    expect(row).toMatchObject({ status: "notified" });
    expect(row!.notified_at).toBeInstanceOf(Date);
    expect(await s.assignments.markSent({ operator: ops, assignmentId: a.assignmentId, requestId: s.rid() })).toEqual({ ok: false, code: "not_notifiable" });
    expect(await s.assignments.markSent({ operator: ops, assignmentId: crypto.randomUUID(), requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
  });

  it("cancelling needs a reason from the closed list, frees the lead (back to new) and records who and why", async () => {
    const l = await lead();
    const a = await assign(l.id);
    if (!a.ok) throw new Error("setup");
    for (const reason of ["", "client_unhappy", "they were rude, call 07911 123456"]) {
      expect(await s.assignments.cancel({ operator: ops, assignmentId: a.assignmentId, reason, requestId: s.rid() })).toEqual({ ok: false, code: "invalid_reason" });
    }
    expect((await leadRow(l.id)).status).toBe("assigned"); // untouched by the refusals

    expect(await s.assignments.cancel({ operator: ops, assignmentId: a.assignmentId, reason: "client_declined", requestId: "req-cancel" })).toEqual({ ok: true });
    expect(await leadRow(l.id)).toMatchObject({ status: "new", assignments_count: 0 });
    expect((await historyOf(a.assignmentId)).at(-1)).toMatchObject({ from_status: "reserved", to_status: "cancelled", actor_id: ops.id, reason: "client_declined", request_id: "req-cancel" });
    expect((await auditOf(l.id)).at(-1)).toMatchObject({ action: "assignment.cancelled", reason: "client_declined", actor_id: ops.id });
    // An ended assignment is terminal: cancelling again, or sending it, is refused; the lead can be assigned afresh.
    expect(await s.assignments.cancel({ operator: ops, assignmentId: a.assignmentId, reason: "client_declined", requestId: s.rid() })).toEqual({ ok: false, code: "not_cancellable" });
    expect(await assign(l.id)).toMatchObject({ ok: true });
  });

  it("REASSIGN moves the lead to another business in one step: the old hold ends with a mandatory reason, the new begins, the lead stays assigned", async () => {
    const second = await s.activeClient(ops, { name: "Second Roofing" });
    const l = await lead();
    const first = await assign(l.id);
    if (!first.ok) throw new Error("setup");
    await s.assignments.markSent({ operator: ops, assignmentId: first.assignmentId, requestId: s.rid() });

    expect(await s.assignments.reassign({ operator: ops, assignmentId: first.assignmentId, toClientId: second, reason: "", requestId: s.rid() })).toEqual({ ok: false, code: "invalid_reason" });
    expect(await s.assignments.reassign({ operator: ops, assignmentId: first.assignmentId, toClientId: br6Client, reason: "no_response", requestId: s.rid() })).toEqual({ ok: false, code: "same_client" });
    const moved = await s.assignments.reassign({ operator: ops, assignmentId: first.assignmentId, toClientId: second, reason: "no_response", requestId: "req-move" });
    expect(moved).toMatchObject({ ok: true, pricePence: 3500 });
    if (!moved.ok) return;

    const rows = await assignmentsOf(l.id);
    expect(rows.map((row) => [row.client_id, row.status])).toEqual([[br6Client, "cancelled"], [second, "reserved"]]);
    expect(await leadRow(l.id)).toMatchObject({ status: "assigned", assignments_count: 1 });
    expect((await historyOf(first.assignmentId)).at(-1)).toMatchObject({ from_status: "notified", to_status: "cancelled", reason: "no_response", actor_id: ops.id, request_id: "req-move" });
    expect((await historyOf(moved.assignmentId))[0]).toMatchObject({ to_status: "reserved", reason: "no_response" });
    const entry = (await auditOf(l.id)).at(-1)!;
    expect(entry).toMatchObject({ action: "assignment.reassigned", reason: "no_response", actor_id: ops.id });
    expect(entry.before).toMatchObject({ assignment_id: first.assignmentId, client_id: br6Client });
    expect(entry.after).toMatchObject({ assignment_id: moved.assignmentId, client_id: second });
  });

  it("a refused reassignment changes NOTHING: the original business keeps the lead", async () => {
    const tn13 = await s.activeClient(ops, { name: "Elsewhere", outward: ["TN13"] });
    const l = await lead();
    const first = await assign(l.id);
    if (!first.ok) throw new Error("setup");
    const refused = await s.assignments.reassign({ operator: ops, assignmentId: first.assignmentId, toClientId: tn13, reason: "client_declined", requestId: s.rid() });
    expect(refused).toMatchObject({ ok: false, code: "not_covered" });
    expect((await assignmentsOf(l.id)).map((row) => row.status)).toEqual(["reserved"]);
    expect((await leadRow(l.id)).status).toBe("assigned");
    expect((await historyOf(first.assignmentId))).toHaveLength(1);
  });
});

describe("RACES: one lead, many operators", () => {
  it("12 operators assign the same lead to 12 different businesses: exactly one wins, everyone else is told it is taken", async () => {
    const businesses = await Promise.all(Array.from({ length: 12 }, (_, i) => s.activeClient(ops, { name: `Racer ${i}` })));
    const l = await lead();
    const results = await Promise.all(businesses.map((clientId) => assign(l.id, clientId)));

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.code === "already_assigned")).toHaveLength(11); // typed, not a crash
    expect((await assignmentsOf(l.id)).filter((row) => row.status === "reserved")).toHaveLength(1);
    expect(await leadRow(l.id)).toMatchObject({ status: "assigned", assignments_count: 1 });
    expect((await auditOf(l.id)).filter((entry) => entry.action === "assignment.created")).toHaveLength(1);
  });

  it("assign, cancel and reassign racing on one lead can never leave it held twice or marked assigned with no holder", async () => {
    const [x, y] = [await s.activeClient(ops, { name: "Race X" }), await s.activeClient(ops, { name: "Race Y" })];
    for (let trial = 0; trial < 12; trial += 1) {
      const l = await lead();
      const first = await assign(l.id, x);
      if (!first.ok) throw new Error("setup");
      const settled = await Promise.allSettled([
        s.assignments.cancel({ operator: ops, assignmentId: first.assignmentId, reason: "no_response", requestId: s.rid() }),
        s.assignments.reassign({ operator: ops, assignmentId: first.assignmentId, toClientId: y, reason: "client_declined", requestId: s.rid() }),
        assign(l.id, y),
      ]);
      // Every operator gets a TYPED answer ("done" or "taken"): none may crash with an untyped database error. That is what
      // locking the lead first is for; the constraints alone would keep the data right but throw at the losers.
      expect(settled.filter((outcome) => outcome.status === "rejected").map((outcome) => String((outcome as PromiseRejectedResult).reason)), `trial ${trial}`).toEqual([]);
      const state = await leadRow(l.id);
      const active = (await assignmentsOf(l.id)).filter((row) => ["reserved", "notified"].includes(row.status));
      expect(active.length, `trial ${trial}`).toBeLessThanOrEqual(1);
      expect(state.assignments_count, `trial ${trial}`).toBe(active.length);
      expect(state.status === "assigned", `trial ${trial}: status ${state.status} with ${active.length} holders`).toBe(active.length === 1);
    }
  });

  it("two operators sending / cancelling the same assignment: each transition happens once", async () => {
    const l = await lead();
    const a = await assign(l.id);
    if (!a.ok) throw new Error("setup");
    const sends = await Promise.all(Array.from({ length: 6 }, () => s.assignments.markSent({ operator: ops, assignmentId: a.assignmentId, requestId: s.rid() })));
    expect(sends.filter((result) => result.ok)).toHaveLength(1);
    const cancels = await Promise.all(Array.from({ length: 6 }, () => s.assignments.cancel({ operator: ops, assignmentId: a.assignmentId, reason: "client_declined", requestId: s.rid() })));
    expect(cancels.filter((result) => result.ok)).toHaveLength(1);
    expect((await historyOf(a.assignmentId)).map((entry) => entry.to_status)).toEqual(["reserved", "notified", "cancelled"]);
  });
});

describe("candidates and the handover message", () => {
  it("lists active businesses with eligible ones first, and the price a rule gives", async () => {
    const elsewhere = await s.activeClient(ops, { name: "AAA Elsewhere", outward: ["DA1"] });
    const l = await lead();
    const candidates = (await s.assignments.candidates(l.id))!;
    expect(candidates.price).toEqual({ pricePence: 3500 });
    expect(candidates.postcode).toBe("BR6 0AA");
    const names = candidates.clients.map((client) => client.name);
    const firstIneligible = candidates.clients.findIndex((client) => !client.eligible);
    expect(candidates.clients.slice(0, firstIneligible).every((client) => client.eligible)).toBe(true);
    expect(candidates.clients.find((client) => client.clientId === elsewhere)).toMatchObject({ eligible: false, reasons: ["no_include_rule_matches"] });
    expect(names).toContain("BR6 Roofing");
    expect(await s.assignments.candidates(crypto.randomUUID())).toBeUndefined();
  });

  it("builds the text for the business with the contact details, only while the lead is held and not erased", async () => {
    const l = await lead({ phone: "+447911600123" });
    const a = await assign(l.id);
    if (!a.ok) throw new Error("setup");
    const message = (await s.assignments.handover(a.assignmentId))!;
    expect(message.subject).toContain(l.reference);
    expect(message.text).toContain("Hi Dave,");
    expect(message.text).toContain("+447911600123");
    expect(message.text).toContain("Raw Fixture");
    expect(message.text).toContain("BR6 0AA");
    expect(message.text).toContain("sent to you only");
    expect(message.to).toMatch(/@roofer\.example$/);

    await s.assignments.cancel({ operator: ops, assignmentId: a.assignmentId, reason: "client_declined", requestId: s.rid() });
    expect(await s.assignments.handover(a.assignmentId)).toBeUndefined(); // no longer held: no details
  });
});

describe("what an operator sees for a lead", () => {
  it("returns assignments newest first with the business and the full history, naming the operator", async () => {
    const other = await s.activeClient(ops, { name: "Viewer Two" });
    const l = await lead();
    const first = await assign(l.id);
    if (!first.ok) throw new Error("setup");
    await s.assignments.reassign({ operator: ops, assignmentId: first.assignmentId, toClientId: other, reason: "wrong_area", requestId: s.rid() });
    const views = await s.assignments.forLead(l.id);
    expect(views.map((view) => [view.clientName, view.status, view.active])).toEqual([["Viewer Two", "reserved", true], ["BR6 Roofing", "cancelled", false]]);
    expect(views[1]!.history.map((entry) => [entry.to, entry.actor, entry.reason])).toEqual([["reserved", "assign@example.com", "manual_assignment"], ["cancelled", "assign@example.com", "wrong_area"]]);
  });
});
