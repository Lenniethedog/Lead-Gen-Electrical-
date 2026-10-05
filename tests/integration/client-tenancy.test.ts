import { sql } from "kysely";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClientScope } from "../../src/lib/db/client-scope";
import type { ClientSession } from "../../src/modules/clientauth";
import { createPortalService } from "../../src/modules/portal";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawAssignment, insertRawClient, insertRawLead } from "../helpers/raw";
import { buildStage3 } from "../helpers/stage3";

/**
 * One business must never see another's data (stage 6, D45). Three layers, and each is proved ALONE:
 *   1. the portal's own `client_id = $1` filters,   2. row-level security keyed on app.client_id,   3. this matrix.
 * The layer tests below run a query WITHOUT the filter, as a careless dashboard change might, and the database must still hold the line.
 */
let t: TestDatabase;
let portal: ReturnType<typeof createPortalService>;
let a: { id: string; session: ClientSession };
let b: { id: string; session: ClientSession };
const ids: { aLead: string; aAssignment: string; bLead: string; bAssignment: string } = { aLead: "", aAssignment: "", bLead: "", bAssignment: "" };

const sessionFor = (id: string, name: string): ClientSession => ({ sessionId: crypto.randomUUID(), userId: crypto.randomUUID(), clientId: id, clientName: name, name: "Person", email: "p@x.example", role: "owner" });
const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  t = await createTestDatabase();
  portal = createPortalService({ db: t.db, logger: pino({ level: "silent" }), assignments: buildStage3(t).assignments });
  const ca = await insertRawClient(t.admin, { name: "Alpha Roofing" });
  const cb = await insertRawClient(t.admin, { name: "Bravo Roofing" });
  a = { id: ca.id, session: sessionFor(ca.id, "Alpha Roofing") };
  b = { id: cb.id, session: sessionFor(cb.id, "Bravo Roofing") };
  const la = await insertRawLead(t.admin, {});
  const lb = await insertRawLead(t.admin, {});
  const aa = await insertRawAssignment(t.admin, la.id, { clientId: a.id, status: "notified" });
  const bb = await insertRawAssignment(t.admin, lb.id, { clientId: b.id, status: "notified" });
  Object.assign(ids, { aLead: la.id, aAssignment: aa.id, bLead: lb.id, bAssignment: bb.id });
});
afterAll(async () => {
  await t.destroy();
});

describe("the database really enforces it for the application role", () => {
  it("the app role neither owns the tables nor bypasses row-level security (or the policies would silently do nothing)", async () => {
    const role = await sql<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean }>`select rolname, rolbypassrls, rolsuper from pg_roles where rolname = current_user`.execute(t.db);
    expect(role.rows[0]).toMatchObject({ rolbypassrls: false, rolsuper: false });
    const owned = await sql<{ relname: string }>`select c.relname from pg_class c where c.relowner = (select oid from pg_roles where rolname = current_user) and c.relkind = 'r'`.execute(t.db);
    expect(owned.rows).toEqual([]);
  });

  it("row-level security is switched on for EVERY table the dashboard reads", async () => {
    const tables = ["lead_assignments", "leads", "lead_contacts", "clients", "assignment_contact_attempts", "client_wallets", "credit_ledger", "lead_charges", "disputes", "client_change_requests", "client_services", "client_service_areas"];
    const { rows } = await sql<{ relname: string; relrowsecurity: boolean }>`select relname, relrowsecurity from pg_class where relname = any(${sql.val(tables)}::text[]) and relkind = 'r'`.execute(t.admin);
    expect(rows.map((r) => r.relname).sort()).toEqual([...tables].sort());
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
  });

  it("and any table the dashboard code queries is on that list (a new table cannot be added without a policy and this test)", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    const source = ["portal", "billing", "disputes"].flatMap((module) => walk(join(import.meta.dirname, "../../src/modules", module))).filter((file) => file.endsWith("repo.ts")).map((file) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")).join("\n");
    const mentioned = new Set([...source.matchAll(/\b(?:from|join|into|update)\s+([a-z_]+)\b/g)].map((m) => m[1]!));
    const known = new Set(["lead_assignments", "leads", "lead_contacts", "clients", "assignment_contact_attempts", "client_wallets", "credit_ledger", "lead_charges", "disputes", "client_change_requests", "client_services", "client_service_areas",
      // read-only reference or staff tables that carry no business's data:
      "service_types", "service_areas", "client_users", "operators", "v_money_problems", "lead_assignments"]);
    const unknown = [...mentioned].filter((name) => !known.has(name) && !["set", "the", "a", "and", "tenant", "now", "interval", "make_interval", "w", "first_contact", "of"].includes(name));
    expect(unknown, "a dashboard repo reads a table that has no row-level security test: add a policy and list it above").toEqual([]);
  });
});

describe("layer 2 alone: a query with NO filter still returns only this business's rows", () => {
  it("assignments, leads, contacts and the business row", async () => {
    const seen = await withClientScope(t.db, a.id, async (scoped) => ({
      assignments: await sql<{ id: string }>`select id from lead_assignments`.execute(scoped),
      leads: await sql<{ id: string }>`select id from leads`.execute(scoped),
      contacts: await sql<{ lead_id: string }>`select lead_id from lead_contacts`.execute(scoped),
      clients: await sql<{ id: string }>`select id from clients`.execute(scoped),
    }));
    expect(seen.assignments.rows.map((r) => r.id)).toEqual([ids.aAssignment]);
    expect(seen.leads.rows.map((r) => r.id)).toEqual([ids.aLead]);
    expect(seen.contacts.rows.map((r) => r.lead_id)).toEqual([ids.aLead]);
    expect(seen.clients.rows.map((r) => r.id)).toEqual([a.id]);
  });

  it("asking for the other business's row BY ID finds nothing", async () => {
    const seen = await withClientScope(t.db, a.id, async (scoped) => ({
      assignment: await sql`select id from lead_assignments where id = ${ids.bAssignment}`.execute(scoped),
      lead: await sql`select id from leads where id = ${ids.bLead}`.execute(scoped),
      contact: await sql`select lead_id from lead_contacts where lead_id = ${ids.bLead}`.execute(scoped),
      client: await sql`select id from clients where id = ${b.id}`.execute(scoped),
    }));
    expect(Object.values(seen).map((r) => r.rows.length)).toEqual([0, 0, 0, 0]);
  });

  it("cannot change or delete the other business's assignment, and cannot write contact details at all", async () => {
    await withClientScope(t.db, a.id, async (scoped) => {
      const update = await sql`update lead_assignments set rejection_reason = 'x' where id = ${ids.bAssignment}`.execute(scoped);
      expect(Number(update.numAffectedRows)).toBe(0);
    });
    // A business can read a person's details, never write them: each of these needs its own transaction, because a refusal aborts it.
    await expect(withClientScope(t.db, a.id, (scoped) => sql`delete from lead_contacts where lead_id = ${ids.aLead}`.execute(scoped))).rejects.toThrow(/permission denied/);
    await expect(withClientScope(t.db, a.id, (scoped) => sql`insert into lead_contacts (lead_id, full_name, phone_e164, email, email_normalised) values (${ids.bLead}, 'x', '+447911000000', 'x@x.x', 'x@x.x')`.execute(scoped))).rejects.toThrow(/row-level security/);
    const rewrite = await withClientScope(t.db, a.id, (scoped) => sql`update lead_contacts set notes = 'changed' where lead_id = ${ids.aLead}`.execute(scoped));
    expect(Number(rewrite.numAffectedRows)).toBe(0);
    const intact = await t.admin.selectFrom("lead_assignments").select("rejection_reason").where("id", "=", ids.bAssignment).executeTakeFirstOrThrow();
    expect(intact.rejection_reason).toBeNull();
    expect(await t.admin.selectFrom("lead_contacts").select("lead_id").where("lead_id", "=", ids.aLead).execute()).toHaveLength(1);
  });

  it("the scope ends with the transaction: the same connection, unscoped, sees everything again", async () => {
    await t.db.connection().execute(async (conn) => {
      const scoped = await withClientScope(conn, a.id, (s) => sql<{ n: string }>`select count(*) as n from lead_assignments`.execute(s));
      expect(Number(scoped.rows[0]!.n)).toBe(1);
      const after = await sql<{ n: string }>`select count(*) as n from lead_assignments`.execute(conn);
      expect(Number(after.rows[0]!.n)).toBeGreaterThanOrEqual(2); // '' after the transaction means "unset", not "match nothing" and not "error"
    });
  });

  it("refuses to scope to anything that is not a business id", async () => {
    for (const bad of ["", "not-a-uuid", "' or 1=1 --", "00000000-0000-0000-0000-000000000000x"]) {
      await expect(withClientScope(t.db, bad, async () => 1)).rejects.toThrow("business id");
    }
  });
});

describe("layer 1 alone: the portal's own filter holds even with row-level security off", () => {
  it("the SQL repeats the business filter (the same lookup, unscoped, still returns nothing for the wrong business)", async () => {
    const { getLeadDetail, listLeads } = await import("../../src/modules/portal/repo");
    expect(await getLeadDetail(t.admin, b.id, ids.aAssignment)).toBeUndefined(); // t.admin is the owner: row-level security does not apply to it
    expect(await getLeadDetail(t.admin, a.id, ids.aAssignment)).toBeDefined();
    const mine = await listLeads(t.admin, a.id, { view: "open", limit: 50 });
    expect(mine.rows.map((r) => r.assignmentId)).toEqual([ids.aAssignment]);
  });
});

describe("layer 3: the portal's functions, pointed at the other business", () => {
  it("lists only its own leads", async () => {
    expect((await portal.leads(a.session, "open")).rows.map((r) => r.reference)).toHaveLength(1);
    const mine = await portal.leads(a.session, "open");
    const theirs = await portal.leads(b.session, "open");
    expect(mine.rows[0]!.assignmentId).toBe(ids.aAssignment);
    expect(theirs.rows[0]!.assignmentId).toBe(ids.bAssignment);
  });

  it("the other business's assignment id gives not found, exactly like an id that does not exist", async () => {
    expect(await portal.lead(a.session, ids.bAssignment, rid())).toBeUndefined();
    expect(await portal.lead(a.session, crypto.randomUUID(), rid())).toBeUndefined();
    expect(await portal.lead(a.session, "not-an-id", rid())).toBeUndefined();
    expect(await portal.lead(a.session, "' or 1=1 --", rid())).toBeUndefined();
  });

  it("a made-up session for a business that does not exist sees nothing", async () => {
    const ghost = sessionFor(crypto.randomUUID(), "Ghost");
    expect((await portal.leads(ghost, "open")).rows).toEqual([]);
    expect((await portal.leads(ghost, "history")).rows).toEqual([]);
    expect(await portal.lead(ghost, ids.aAssignment, rid())).toBeUndefined();
  });

  it("a refused look leaves no trace in the audit trail (nothing was revealed)", async () => {
    const before = await t.admin.selectFrom("audit_logs").select("id").where("action", "=", "lead.contact_viewed").execute();
    await portal.lead(b.session, ids.aAssignment, rid());
    expect(await t.admin.selectFrom("audit_logs").select("id").where("action", "=", "lead.contact_viewed").execute()).toHaveLength(before.length);
  });
});

describe("a person's details are shown only while the business HOLDS the lead (D46)", () => {
  type Status = "reserved" | "notified" | "accepted" | "disputed" | "rejected" | "refunded" | "expired" | "cancelled" | "delivery_failed";

  /** Puts a fresh lead into the given state for business A, by the legal route: system-actor transitions in the database. */
  async function leadIn(status: Status, options: { notified?: boolean } = {}): Promise<{ assignmentId: string; leadId: string }> {
    const lead = await insertRawLead(t.admin, {});
    const assignment = await insertRawAssignment(t.admin, lead.id, { clientId: a.id, status: "reserved" });
    const path: Record<Status, Status[]> = {
      reserved: [], notified: ["notified"], accepted: ["notified", "accepted"], disputed: ["notified", "disputed"], rejected: ["notified", "rejected"],
      refunded: ["notified", "disputed", "refunded"], expired: options.notified === false ? ["expired"] : ["notified", "expired"],
      cancelled: options.notified === false ? ["cancelled"] : ["notified", "cancelled"], delivery_failed: ["delivery_failed"],
    };
    for (const step of path[status]) {
      await t.admin.transaction().execute(async (trx) => {
        await sql`select set_config('app.actor_type', 'system', true), set_config('app.reason', 'test', true), set_config('app.request_id', 'test', true)`.execute(trx);
        await sql`update lead_assignments set status = ${step}::assignment_status, notified_at = case when ${step} = 'notified' then now() else notified_at end where id = ${assignment.id}`.execute(trx);
      });
    }
    return { assignmentId: assignment.id, leadId: lead.id };
  }

  const HELD: Status[] = ["reserved", "notified", "accepted", "disputed"];
  const SEEN_BUT_NOT_HELD: Status[] = ["rejected", "refunded", "expired", "cancelled"];

  for (const status of HELD) {
    it(`${status}: the business sees who it is, and the full postcode`, async () => {
      const { assignmentId } = await leadIn(status);
      const detail = await portal.lead(a.session, assignmentId, rid());
      expect(detail?.contactState).toBe("visible");
      expect(detail?.contact).toMatchObject({ name: expect.any(String), phone: expect.stringMatching(/^\+44/), email: expect.stringContaining("@") });
      expect(detail?.postcode).toMatch(/^[A-Z]{1,2}\d/);
    });
  }

  for (const status of SEEN_BUT_NOT_HELD) {
    it(`${status}: the business still sees the job, but NOT the person or the full postcode`, async () => {
      const { assignmentId } = await leadIn(status);
      const detail = await portal.lead(a.session, assignmentId, rid());
      expect(detail).toBeDefined();
      expect(detail?.contactState).toBe("not_held");
      expect(detail?.contact).toBeNull();
      expect(detail?.postcode).toBeNull();
      expect(detail?.district).toMatch(/^[A-Z]{1,2}\d/);
    });
  }

  it("layer 2 alone: a RAW query for a person's details returns them while the lead is held and nothing once it is not", async () => {
    const held = await leadIn("accepted");
    const ended = await leadIn("rejected");
    const seen = await withClientScope(t.db, a.id, async (scoped) => ({
      held: await sql`select lead_id from lead_contacts where lead_id = ${held.leadId}`.execute(scoped),
      ended: await sql`select lead_id from lead_contacts where lead_id = ${ended.leadId}`.execute(scoped),
      endedLead: await sql`select id from leads where id = ${ended.leadId}`.execute(scoped), // the job itself stays visible
    }));
    expect(seen.held.rows).toHaveLength(1);
    expect(seen.ended.rows).toHaveLength(0);
    expect(seen.endedLead.rows).toHaveLength(1);
  });

  it("delivery_failed, and cancelled or expired before the business was ever told, are not shown at all", async () => {
    const failed = await leadIn("delivery_failed");
    const quiet = await leadIn("cancelled", { notified: false });
    expect(await portal.lead(a.session, failed.assignmentId, rid())).toBeUndefined();
    expect(await portal.lead(a.session, quiet.assignmentId, rid())).toBeUndefined();
    const listed = [...(await portal.leads(a.session, "open")).rows, ...(await portal.leads(a.session, "history")).rows].map((r) => r.assignmentId);
    expect(listed).not.toContain(failed.assignmentId);
    expect(listed).not.toContain(quiet.assignmentId);
  });

  it("lists held leads under 'open' and ended ones under 'history', never both, newest first", async () => {
    const open = (await portal.leads(a.session, "open")).rows;
    const history = (await portal.leads(a.session, "history")).rows;
    expect(open.every((r) => ["reserved", "notified", "accepted", "disputed"].includes(r.status))).toBe(true);
    expect(history.every((r) => !["reserved", "notified", "accepted", "disputed"].includes(r.status))).toBe(true);
    const times = open.map((r) => r.assignedAt.getTime());
    expect([...times].sort((x, y) => y - x)).toEqual(times);
    expect(open.filter((r) => history.some((h) => h.assignmentId === r.assignmentId))).toEqual([]);
  });

  it("the list never carries the person's details or the full postcode", async () => {
    const rows = [...(await portal.leads(a.session, "open")).rows, ...(await portal.leads(a.session, "history")).rows];
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/\+44\d{9}/);
    expect(text).not.toContain("@");
    expect(rows.every((r) => /^[A-Z]{1,2}\d[A-Z\d]?$/.test(r.district))).toBe(true);
  });

  it("a person whose data was erased shows as erased, never as their old details", async () => {
    const { assignmentId, leadId } = await leadIn("accepted");
    await t.admin.transaction().execute(async (trx) => {
      await sql`update lead_contacts set full_name = null, phone_e164 = null, email = null, email_normalised = null, notes = null, erased_at = now() where lead_id = ${leadId}`.execute(trx);
      await sql`update leads set erased_at = now(), postcode = null where id = ${leadId}`.execute(trx);
    });
    const detail = await portal.lead(a.session, assignmentId, rid());
    expect(detail?.contactState).toBe("erased");
    expect(detail?.contact).toBeNull();
    expect(detail?.postcode).toBeNull();
  });

  it("every reveal of a person's details is audited with who and which lead, and never with the details", async () => {
    const { assignmentId } = await leadIn("notified");
    const requestId = rid();
    const detail = await portal.lead(a.session, assignmentId, requestId);
    const entries = await t.admin.selectFrom("audit_logs").selectAll().where("action", "=", "lead.contact_viewed").where("entity_id", "=", assignmentId).execute();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor_type: "client_user", actor_id: a.session.userId, request_id: requestId, entity_type: "assignment" });
    const text = JSON.stringify(entries[0]);
    expect(text).not.toContain(detail!.contact!.phone);
    expect(text).not.toContain(detail!.contact!.email);
    expect(text).not.toContain(detail!.contact!.name);
  });

  it("looking at a lead whose details are hidden writes no reveal record", async () => {
    const { assignmentId } = await leadIn("rejected");
    await portal.lead(a.session, assignmentId, rid());
    expect(await t.admin.selectFrom("audit_logs").select("id").where("action", "=", "lead.contact_viewed").where("entity_id", "=", assignmentId).execute()).toHaveLength(0);
  });
});
