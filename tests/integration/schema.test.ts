import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OWNERSHIP_VALUES, PROPERTY_TYPE_VALUES, URGENCY_VALUES } from "../../src/config/lead-options";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawAssignment, insertRawLead } from "../helpers/raw";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

/** Resolves to the Postgres error (code + message) a statement raises, or fails the test if none. */
async function pgError(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? "", message: e.message ?? "" };
  }
  throw new Error("expected the statement to fail");
}

async function enumLabels(typeName: string): Promise<string[]> {
  const { rows } = await sql<{ enumlabel: string }>`
    select e.enumlabel from pg_enum e join pg_type ty on ty.oid = e.enumtypid
    where ty.typname = ${typeName} order by e.enumsortorder`.execute(t.admin);
  return rows.map((row) => row.enumlabel);
}

describe("enums stay in sync with the TypeScript constants the form and API use", () => {
  it.each([
    ["property_type", PROPERTY_TYPE_VALUES],
    ["ownership_type", OWNERSHIP_VALUES],
    ["urgency_level", URGENCY_VALUES],
  ] as const)("%s", async (typeName, values) => {
    expect((await enumLabels(typeName)).sort()).toEqual([...values].sort());
  });

  it("every lead status has an entry in the transitions table or is deliberately terminal", async () => {
    const statuses = await enumLabels("lead_status");
    const { rows } = await sql<{ from_status: string }>`select distinct from_status from lead_status_transitions`.execute(t.admin);
    const withExits = new Set(rows.map((row) => row.from_status));
    const terminal = statuses.filter((status) => !withExits.has(status));
    expect(terminal.sort()).toEqual(["invalid"]);
  });
});

describe("postcodes table", () => {
  it("derives outward, sector and area from the postcode", async () => {
    const row = await t.admin.selectFrom("postcodes").select(["outward", "sector", "area"]).where("postcode", "=", "BR6 0AA").executeTakeFirstOrThrow();
    expect(row).toEqual({ outward: "BR6", sector: "BR6 0", area: "BR" });
  });

  it("only stores canonical postcodes", async () => {
    // Rejected by the format CHECK (23514) or, because the derived area is then NULL, by NOT NULL (23502).
    const error = await pgError(sql`insert into postcodes (postcode) values ('br6 0aa')`.execute(t.admin));
    expect(["23514", "23502"]).toContain(error.code);
  });
});

describe("lead lifecycle is enforced by the database", () => {
  it("allows a legal path and records who did what in the status history", async () => {
    const lead = await insertRawLead(t.admin);

    await t.admin.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'system', true), set_config('app.request_id', 'req-router-1', true)`.execute(trx);
      await trx.updateTable("leads").set({ status: "routing" }).where("id", "=", lead.id).execute();
      await insertRawAssignment(trx, lead.id); // a lead can only be `assigned` if a business holds it (checked at COMMIT)
      await trx.updateTable("leads").set({ status: "assigned" }).where("id", "=", lead.id).execute();
    });

    const history = await t.admin
      .selectFrom("lead_status_history")
      .select(["from_status", "to_status", "actor_type", "request_id"])
      .where("lead_id", "=", lead.id)
      .orderBy("id")
      .execute();
    expect(history).toEqual([
      { from_status: null, to_status: "new", actor_type: "system", request_id: null },
      { from_status: "new", to_status: "routing", actor_type: "system", request_id: "req-router-1" },
      { from_status: "routing", to_status: "assigned", actor_type: "system", request_id: "req-router-1" },
    ]);
  });

  it.each([
    ["new", "duplicate"],
    ["new", "rejected_fraud"],
    ["assigned", "routing"],
    ["invalid", "new"],
    ["held", "routing"],
    ["expired", "assigned"],
  ] as const)("rejects the illegal transition %s -> %s", async (from, to) => {
    const lead = await insertRawLead(t.admin, { status: from });
    const error = await pgError(t.admin.updateTable("leads").set({ status: to }).where("id", "=", lead.id).execute());
    expect(error.code).toBe("23514");
    expect(error.message).toContain(`illegal lead status transition: ${from} -> ${to}`);
    const current = await t.admin.selectFrom("leads").select("status").where("id", "=", lead.id).executeTakeFirstOrThrow();
    expect(current.status).toBe(from);
  });

  it("allows a staff override of an automated duplicate decision once the link is cleared", async () => {
    const original = await insertRawLead(t.admin);
    const dupe = await insertRawLead(t.admin, { status: "duplicate", duplicateOfLeadId: original.id });
    await t.admin.updateTable("leads").set({ status: "new", duplicate_of_lead_id: null }).where("id", "=", dupe.id).execute();
    const row = await t.admin.selectFrom("leads").select("status").where("id", "=", dupe.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("new");
  });

  it("requires duplicate status and duplicate link to agree, and forbids a lead duplicating itself", async () => {
    const original = await insertRawLead(t.admin);
    expect((await pgError(insertRawLead(t.admin, { status: "duplicate" }))).code).toBe("23514");
    expect((await pgError(insertRawLead(t.admin, { status: "new", duplicateOfLeadId: original.id }))).code).toBe("23514");
    const error = await pgError(
      sql`update leads set duplicate_of_lead_id = id, status = 'duplicate' where id = ${original.id}`.execute(t.admin),
    );
    expect(error.code).toBe("23514");
  });

  it("refreshes status_changed_at only when the status actually changes", async () => {
    const lead = await insertRawLead(t.admin);
    const before = await t.admin.selectFrom("leads").select("status_changed_at").where("id", "=", lead.id).executeTakeFirstOrThrow();
    await t.admin.updateTable("leads").set({ is_test: true }).where("id", "=", lead.id).execute();
    const same = await t.admin.selectFrom("leads").select("status_changed_at").where("id", "=", lead.id).executeTakeFirstOrThrow();
    expect(same.status_changed_at).toEqual(before.status_changed_at);
  });
});

describe("a lead cannot be committed without consent and contact details", () => {
  it("fails at COMMIT when there is no consent record", async () => {
    const error = await pgError(insertRawLead(t.admin, { skipConsent: true }));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("without recorded consent");
  });

  it("fails at COMMIT when there are no contact details", async () => {
    const error = await pgError(insertRawLead(t.admin, { skipContact: true }));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("without contact details");
  });

  it("leaves nothing behind when the commit is refused", async () => {
    const before = await t.admin.selectFrom("leads").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow();
    await pgError(insertRawLead(t.admin, { skipConsent: true }));
    const after = await t.admin.selectFrom("leads").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
  });
});

describe("personal data erasure is a single, constrained operation", () => {
  it("accepts a complete erasure and rejects a half-blanked contact", async () => {
    const lead = await insertRawLead(t.admin);

    const half = await pgError(t.db.updateTable("lead_contacts").set({ full_name: null }).where("lead_id", "=", lead.id).execute());
    expect(half.code).toBe("23514");

    await t.db
      .updateTable("lead_contacts")
      .set({ full_name: null, phone_e164: null, email: null, email_normalised: null, notes: null, ip: null, user_agent: null, erased_at: new Date() })
      .where("lead_id", "=", lead.id)
      .execute();
    const row = await t.admin.selectFrom("lead_contacts").select(["full_name", "erased_at"]).where("lead_id", "=", lead.id).executeTakeFirstOrThrow();
    expect(row.full_name).toBeNull();
    expect(row.erased_at).not.toBeNull();
  });

  it("refuses erased_at on a row that still holds personal data", async () => {
    const lead = await insertRawLead(t.admin);
    const error = await pgError(t.db.updateTable("lead_contacts").set({ erased_at: new Date() }).where("lead_id", "=", lead.id).execute());
    expect(error.code).toBe("23514");
  });
});

describe("audit evidence is append-only", () => {
  it("blocks edits and deletes on evidence tables even for the owner", async () => {
    const lead = await insertRawLead(t.admin);
    await t.admin.insertInto("lead_events").values({ lead_id: lead.id, type: "lead.received" }).execute();
    await t.admin.insertInto("lead_fraud_signals").values({ lead_id: lead.id, code: "voip_phone", weight: 15 }).execute();

    for (const statement of [
      sql`update lead_events set type = 'lead.tampered' where lead_id = ${lead.id}`,
      sql`delete from lead_events where lead_id = ${lead.id}`,
      sql`update lead_status_history set reason = 'x' where lead_id = ${lead.id}`,
      sql`delete from lead_status_history where lead_id = ${lead.id}`,
      sql`update lead_fraud_signals set weight = 0 where lead_id = ${lead.id}`,
      sql`delete from lead_fraud_signals where lead_id = ${lead.id}`,
      sql`update consent_records set event = 'withdrawn' where lead_id = ${lead.id}`,
      sql`delete from consent_records where lead_id = ${lead.id}`,
    ]) {
      const error = await pgError(statement.execute(t.admin));
      expect(error.code).toBe("23514");
      expect(error.message).toContain("append-only");
    }
  });

  it("makes published consent wording immutable but allows retirement", async () => {
    const text = await t.admin.selectFrom("consent_texts").select("id").executeTakeFirstOrThrow();
    expect((await pgError(sql`update consent_texts set body = body || ' (edited)' where id = ${text.id}`.execute(t.admin))).code).toBe("23514");
    expect((await pgError(sql`update consent_texts set max_recipients = 5 where id = ${text.id}`.execute(t.admin))).code).toBe("23514");
    expect((await pgError(sql`delete from consent_texts where id = ${text.id}`.execute(t.admin))).code).toBe("23514");
    await sql`update consent_texts set retired_at = now() where id = ${text.id}`.execute(t.admin);
    await sql`update consent_texts set retired_at = null where id = ${text.id}`.execute(t.admin);
  });

  it("keeps consent evidence even if someone tries to delete the lead", async () => {
    const lead = await insertRawLead(t.admin);
    const error = await pgError(sql`delete from leads where id = ${lead.id}`.execute(t.admin));
    expect(error.code).toBe("23503");
  });
});

describe("the application role has least privilege", () => {
  it("can do what stage 1 needs", async () => {
    const lead = await insertRawLead(t.db);
    await t.db.insertInto("lead_events").values({ lead_id: lead.id, type: "lead.received" }).execute();
    await t.db.updateTable("leads").set({ status: "routing" }).where("id", "=", lead.id).execute();
    const history = await t.db.selectFrom("lead_status_history").select("to_status").where("lead_id", "=", lead.id).orderBy("id").execute();
    expect(history.map((row) => row.to_status)).toEqual(["new", "routing"]);
  });

  it.each([
    ["delete a lead", sql`delete from leads`],
    ["delete contacts", sql`delete from lead_contacts`],
    ["edit events", sql`update lead_events set type = 'lead.x'`],
    ["delete events", sql`delete from lead_events`],
    ["write status history directly", sql`insert into lead_status_history (lead_id, to_status, actor_type) values (gen_random_uuid(), 'new', 'system')`],
    ["edit status history", sql`update lead_status_history set reason = 'x'`],
    ["edit consent records", sql`update consent_records set event = 'withdrawn'`],
    ["change reference data", sql`update service_types set active = false`],
    ["change the postcode directory", sql`delete from postcodes`],
    ["publish consent wording", sql`insert into consent_texts (code, version, body, body_sha256, recipient_model, max_recipients, channels) values ('x','v9','xxxxxxxxxxxxxxxxxxxxxxxx', repeat('0',64), 'shared_one', 1, array['email'])`],
    ["read migration history", sql`select * from pgmigrations`],
    ["create tables", sql`create table sneaky (id int)`],
  ])("cannot %s", async (_name, statement) => {
    const error = await pgError(statement.execute(t.db));
    expect(error.code).toBe("42501");
  });

  it("forges no history: the history trigger is the only writer", async () => {
    const lead = await insertRawLead(t.db);
    const rows = await t.db.selectFrom("lead_status_history").select("id").where("lead_id", "=", lead.id).execute();
    expect(rows).toHaveLength(1);
  });
});
