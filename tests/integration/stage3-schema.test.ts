import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawAssignment, insertRawClient, insertRawLead } from "../helpers/raw";

/**
 * The guarantees of migration 0003 that the application relies on but must not be the only keeper of: a lead cannot be
 * assigned without consent to be shared, after that consent is withdrawn, or after erasure; its recipient cap cannot exceed
 * what the consumer agreed to; it cannot be `assigned` while nobody holds it; ending an assignment by hand needs a person and
 * a reason; prices are never edited; the audit trail is append-only. (Exclusivity and shared-cap RACES are in
 * target-schema.test.ts.)
 */
let t: TestDatabase;
let operatorId: string;
let firstPartyConsentId: number;

beforeAll(async () => {
  t = await createTestDatabase();
  operatorId = (await t.admin.insertInto("operators").values({ email: "stage3@example.com" }).returning("id").executeTakeFirstOrThrow()).id;
  firstPartyConsentId = (
    await t.admin
      .insertInto("consent_texts")
      .values({ code: "first_party_only", version: "v901", body: "We will contact you ourselves, not a business.", body_sha256: "b".repeat(64), recipient_model: "first_party", max_recipients: 0, channels: ["phone"] })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(async () => {
  await t.destroy();
});

const code = async (promise: Promise<unknown>) => ((await promise.then(() => ({}), (error: unknown) => error)) as { code?: string; message?: string });

describe("clients", () => {
  it("requires a lower-case contact email, a valid E.164 phone, and at least one offer type", async () => {
    const vertical = await t.admin.selectFrom("verticals").select("id").executeTakeFirstOrThrow();
    const base = { vertical_id: vertical.id, name: "Roofer", contact_email: "roofer@example.com" };
    expect((await code(t.admin.insertInto("clients").values({ ...base, contact_email: "Roofer@Example.com" }).execute())).code).toBe("23514");
    expect((await code(t.admin.insertInto("clients").values({ ...base, contact_phone_e164: "07911 123456" }).execute())).code).toBe("23514");
    expect((await code(t.admin.insertInto("clients").values({ ...base, accepts_exclusive: false, accepts_shared: false }).execute())).code).toBe("23514");
    expect((await code(t.admin.insertInto("clients").values({ ...base, name: "" }).execute())).code).toBe("23514");
    await t.admin.insertInto("clients").values({ ...base, contact_phone_e164: "+447911123456" }).execute();
  });

  it("the application role can create and update clients but never delete one", async () => {
    const client = await insertRawClient(t.db);
    await t.db.updateTable("clients").set({ status: "paused" }).where("id", "=", client.id).execute();
    expect((await code(t.db.deleteFrom("clients").where("id", "=", client.id).execute())).code).toBe("42501");
  });
});

describe("prices are never edited, only ended and replaced", () => {
  async function rule() {
    const vertical = await t.admin.selectFrom("verticals").select("id").executeTakeFirstOrThrow();
    return t.admin.insertInto("pricing_rules").values({ vertical_id: vertical.id, sale_type: "exclusive", price_pence: 3500, created_by: operatorId }).returning("id").executeTakeFirstOrThrow();
  }

  it("refuses to change the price, the scope or the start of a rule", async () => {
    const { id } = await rule();
    for (const change of [{ price_pence: 1 }, { sale_type: "shared" as const }, { urgency: "emergency" as const }, { priority: 5 }]) {
      expect((await code(t.admin.updateTable("pricing_rules").set(change).where("id", "=", id).execute())).code, JSON.stringify(change)).toBe("23514");
    }
    expect((await code(sql`update pricing_rules set valid_during = tstzrange(now() - interval '1 day', null) where id = ${id}`.execute(t.admin))).code).toBe("23514");
  });

  it("allows a rule to be ended, but not un-ended or extended afterwards, and never deleted", async () => {
    const { id } = await rule();
    await sql`update pricing_rules set valid_during = tstzrange(lower(valid_during), now() + interval '1 hour') where id = ${id}`.execute(t.admin);
    expect((await code(sql`update pricing_rules set valid_during = tstzrange(lower(valid_during), null) where id = ${id}`.execute(t.admin))).code).toBe("23514");
    expect((await code(t.admin.deleteFrom("pricing_rules").where("id", "=", id).execute())).code).toBe("23514");
  });
});

describe("consent is enforced where the assignment is made", () => {
  it("refuses an assignment for a lead whose consent allows no business at all (first-party wording)", async () => {
    const lead = await insertRawLead(t.admin, { consentTextId: firstPartyConsentId });
    const error = await code(insertRawAssignment(t.admin, lead.id));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("no consent to be shared");
  });

  it("refuses an assignment once consent has been withdrawn", async () => {
    const lead = await insertRawLead(t.admin);
    const consent = await t.admin.selectFrom("consent_records").select("consent_text_id").where("lead_id", "=", lead.id).executeTakeFirstOrThrow();
    await t.db.insertInto("consent_records").values({ lead_id: lead.id, consent_text_id: consent.consent_text_id, event: "withdrawn", method: "operator_request" }).execute();
    const error = await code(insertRawAssignment(t.admin, lead.id));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("withdrawn");
  });

  it("refuses an assignment for an erased or deleted lead", async () => {
    const erased = await insertRawLead(t.admin);
    await t.admin.updateTable("leads").set({ erased_at: new Date() }).where("id", "=", erased.id).execute();
    expect((await code(insertRawAssignment(t.admin, erased.id))).message).toContain("erased or deleted");
    const deleted = await insertRawLead(t.admin);
    await t.admin.updateTable("leads").set({ deleted_at: new Date() }).where("id", "=", deleted.id).execute();
    expect((await code(insertRawAssignment(t.admin, deleted.id))).message).toContain("erased or deleted");
  });

  it("never lets a lead's recipient cap exceed what the consumer agreed to", async () => {
    const lead = await insertRawLead(t.admin); // seeded wording: ONE business
    expect((await code(t.admin.updateTable("leads").set({ max_assignments: 2 }).where("id", "=", lead.id).execute())).code).toBe("23514");
    await t.admin.updateTable("leads").set({ max_assignments: 1 }).where("id", "=", lead.id).execute(); // unchanged value: fine
    const none = await insertRawLead(t.admin, { consentTextId: firstPartyConsentId });
    expect((await code(t.admin.updateTable("leads").set({ max_assignments: 2 }).where("id", "=", none.id).execute())).code).toBe("23514");
  });
});

describe("a lead can only be `assigned` while a business holds it", () => {
  it("fails at COMMIT when a lead is marked assigned with no assignment", async () => {
    const lead = await insertRawLead(t.admin);
    const error = await code(t.admin.updateTable("leads").set({ status: "assigned" }).where("id", "=", lead.id).execute());
    expect(error.code).toBe("23514");
    expect(error.message).toContain("no business holds it");
    expect((await t.admin.selectFrom("leads").select("status").where("id", "=", lead.id).executeTakeFirstOrThrow()).status).toBe("new");
  });

  it("accepts the status change and the assignment in either order inside one transaction", async () => {
    const [first, second] = [await insertRawLead(t.admin), await insertRawLead(t.admin)];
    await t.admin.transaction().execute(async (trx) => {
      await insertRawAssignment(trx, first.id);
      await trx.updateTable("leads").set({ status: "assigned" }).where("id", "=", first.id).execute();
    });
    await t.admin.transaction().execute(async (trx) => {
      await trx.updateTable("leads").set({ status: "assigned" }).where("id", "=", second.id).execute();
      await insertRawAssignment(trx, second.id);
    });
    expect((await t.admin.selectFrom("leads").select("assignments_count").where("id", "=", second.id).executeTakeFirstOrThrow()).assignments_count).toBe(1);
  });

  it("refuses to end the only assignment while the lead is still marked assigned", async () => {
    const lead = await insertRawLead(t.admin, { status: "assigned" });
    const error = await code(
      t.admin.transaction().execute(async (trx) => {
        await sql`select set_config('app.actor_type', 'system', true)`.execute(trx);
        await sql`update lead_assignments set status = 'cancelled' where lead_id = ${lead.id}`.execute(trx);
      }),
    );
    expect(error.code).toBe("23514");
    // The honest way: free the lead in the same transaction.
    await t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'system', true)`.execute(trx);
      await sql`update lead_assignments set status = 'cancelled' where lead_id = ${lead.id}`.execute(trx);
      await trx.updateTable("leads").set({ status: "new" }).where("id", "=", lead.id).execute();
    });
  });
});

describe("ending an assignment by hand needs a person and a reason", () => {
  async function ending(context: { actorType?: string; actorId?: string; reason?: string }, to: "cancelled" | "rejected" = "cancelled") {
    const lead = await insertRawLead(t.admin);
    const assignment = await insertRawAssignment(t.admin, lead.id, { status: "notified" });
    return code(
      t.admin.transaction().execute(async (trx) => {
        await sql`select set_config('app.actor_type', ${context.actorType ?? ""}, true), set_config('app.actor_id', ${context.actorId ?? ""}, true), set_config('app.reason', ${context.reason ?? ""}, true)`.execute(trx);
        await sql`update lead_assignments set status = ${to}::assignment_status where id = ${assignment.id}`.execute(trx);
      }),
    ).then((error) => ({ error, assignment }));
  }

  it("refuses with no actor, an unknown actor type, or a staff actor without id or reason", async () => {
    for (const to of ["cancelled", "rejected"] as const) {
      for (const context of [{}, { actorType: "consumer", reason: "x" }, { actorType: "staff_user", reason: "client_declined" }, { actorType: "staff_user", actorId: operatorId }]) {
        expect((await ending(context, to)).error.code, JSON.stringify(context)).toBe("23514");
      }
    }
  });

  it("accepts a staff actor with an id and reason (recorded in the history), and an automated actor", async () => {
    const staff = await ending({ actorType: "staff_user", actorId: operatorId, reason: "client_declined" });
    expect(staff.error.code).toBeUndefined();
    const history = await t.admin.selectFrom("lead_assignment_status_history").selectAll().where("assignment_id", "=", staff.assignment.id).orderBy("id").execute();
    expect(history.at(-1)).toMatchObject({ from_status: "notified", to_status: "cancelled", actor_type: "staff_user", actor_id: operatorId, reason: "client_declined" });
    expect((await ending({ actorType: "system" })).error.code).toBeUndefined();
  });

  it("does not get in the way of ordinary progress (reserved -> notified -> accepted)", async () => {
    const lead = await insertRawLead(t.admin);
    const assignment = await insertRawAssignment(t.admin, lead.id);
    await sql`update lead_assignments set status = 'notified' where id = ${assignment.id}`.execute(t.admin);
    await sql`update lead_assignments set status = 'accepted' where id = ${assignment.id}`.execute(t.admin);
  });
});

describe("the audit trail and privacy records", () => {
  it("audit_logs is append-only and its entries are well-formed", async () => {
    const entry = { actor_type: "staff_user" as const, actor_id: operatorId, action: "client.created", entity_type: "client", entity_id: "x", reason: "test" };
    await t.db.insertInto("audit_logs").values(entry).execute();
    expect((await code(t.admin.updateTable("audit_logs").set({ reason: "edited" }).execute())).code).toBe("23514");
    expect((await code(t.admin.deleteFrom("audit_logs").execute())).code).toBe("23514");
    expect((await code(t.db.insertInto("audit_logs").values({ ...entry, action: "NotAnAction" }).execute())).code).toBe("23514");
    expect((await code(t.db.insertInto("audit_logs").values({ ...entry, entity_type: "Client Row" }).execute())).code).toBe("23514");
    expect((await code(t.db.insertInto("audit_logs").values({ ...entry, entity_id: "x".repeat(101) }).execute())).code).toBe("23514");
  });

  it("suppressions hold a keyed hash only, once per (kind, value), and are insert-only for the application", async () => {
    const hmac = "c".repeat(64);
    await t.db.insertInto("suppressions").values({ kind: "phone", value_hmac: hmac, reason: "erasure" }).execute();
    expect((await code(t.db.insertInto("suppressions").values({ kind: "phone", value_hmac: hmac, reason: "opt_out" }).execute())).code).toBe("23505");
    await t.db.insertInto("suppressions").values({ kind: "email", value_hmac: hmac, reason: "erasure" }).execute(); // same value, different kind
    expect((await code(t.db.insertInto("suppressions").values({ kind: "phone", value_hmac: "07911123456", reason: "erasure" }).execute())).code).toBe("23514");
    expect((await code(t.db.deleteFrom("suppressions").execute())).code).toBe("42501");
    expect((await code(t.db.updateTable("suppressions").set({ reason: "opt_out" }).execute())).code).toBe("42501");
  });

  it("the application role cannot delete assignments or their history, but can manage coverage rules", async () => {
    const lead = await insertRawLead(t.admin);
    const assignment = await insertRawAssignment(t.admin, lead.id);
    expect((await code(t.db.deleteFrom("lead_assignments").where("id", "=", assignment.id).execute())).code).toBe("42501");
    expect((await code(t.db.deleteFrom("lead_assignment_status_history").execute())).code).toBe("42501");
    expect((await code(t.db.insertInto("lead_assignment_status_history").values({ assignment_id: assignment.id, to_status: "accepted", actor_type: "system" }).execute())).code).toBe("42501");

    const client = await insertRawClient(t.db);
    const rule = await t.db.insertInto("client_service_areas").values({ client_id: client.id, kind: "outward", outward: "BR6" }).returning("id").executeTakeFirstOrThrow();
    await t.db.deleteFrom("client_service_areas").where("id", "=", rule.id).execute();
  });
});
