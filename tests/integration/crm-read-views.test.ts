import { sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEAD_EVENT } from "../../src/config/lead-events";
import { needsAPerson } from "../../src/lib/db/lead-predicates";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawAssignment, insertRawClient, insertRawLead } from "../helpers/raw";
import { CRM_ROLE, CRM_ROLE_PASSWORD, crmRoleScript } from "../setup/postgres";

/**
 * The read-only contract the cross-trade CRM relies on (migration 0015, db/roles-crm.sql, decision D68).
 *
 * What must hold: the CRM role can read the crm views and nothing else, can write nothing, and the views never carry a consumer's
 * details. The column list is pinned on purpose: a change to the contract is a change to another project, so it must be deliberate.
 */

let t: TestDatabase;
let crm: Client;

function crmUrl(ownerUrl: string): string {
  const url = new URL(ownerUrl);
  url.username = CRM_ROLE;
  url.password = CRM_ROLE_PASSWORD;
  return url.toString();
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "no-code";
  }
  return "succeeded";
}

beforeAll(async () => {
  t = await createTestDatabase();
  crm = new Client({ connectionString: crmUrl(t.ownerUrl) });
  await crm.connect();
});
afterAll(async () => {
  await crm.end();
  await t.destroy();
});

const CONTRACT: Record<string, string[]> = {
  assignments_v1: ["id", "lead_id", "client_id", "status", "sale_type", "price_pence", "reserved_at", "notified_at", "accepted_at", "rejected_at", "updated_at"],
  charges_v1: ["id", "client_id", "assignment_id", "amount_pence", "status", "created_at", "reversed_at"],
  client_services_v1: ["client_id", "service_slug", "service_label"],
  clients_v1: ["id", "name", "status", "billing_mode", "delivery_mode", "balance_pence", "created_at", "updated_at"],
  disputes_v1: ["id", "client_id", "assignment_id", "status", "reason", "resolution", "created_at", "decided_at"],
  leads_v1: [
    "id", "reference", "created_at", "status", "status_changed_at", "service_slug", "service_label", "postcode_outward", "urgency",
    "fraud_decision", "assignments_count", "erased", "needs_person",
  ],
  outcomes_v1: ["id", "assignment_id", "client_id", "outcome", "job_value_pence", "occurred_at"],
  trade_v1: ["slug", "name", "contract_version"],
};

describe("the crm contract", () => {
  it("has exactly the agreed views and columns", async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      select table_name, column_name from information_schema.columns
      where table_schema = 'crm' order by table_name, ordinal_position`.execute(t.admin);
    const actual: Record<string, string[]> = {};
    for (const row of rows) (actual[row.table_name] ??= []).push(row.column_name);
    expect(actual).toEqual(CONTRACT);
  });

  it("says which trade this database is", async () => {
    const { rows } = await crm.query("select slug, name, contract_version from crm.trade_v1");
    expect(rows).toEqual([{ slug: "electrical", name: expect.any(String), contract_version: 1 }]);
  });
});

describe("the crm role", () => {
  it("can read every crm view and no other table, view or sequence", async () => {
    const { rows } = await sql<{ schema: string; name: string; kind: string; can_read: boolean; can_write: boolean }>`
      select n.nspname as schema, c.relname as name, c.relkind::text as kind,
             case when c.relkind = 'S' then has_sequence_privilege(${CRM_ROLE}, c.oid, 'SELECT,USAGE')
                  else has_table_privilege(${CRM_ROLE}, c.oid, 'SELECT') end as can_read,
             case when c.relkind = 'S' then has_sequence_privilege(${CRM_ROLE}, c.oid, 'UPDATE')
                  else has_table_privilege(${CRM_ROLE}, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end as can_write
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'
        and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')`.execute(t.admin);

    expect(rows.length).toBeGreaterThan(40);
    expect(rows.filter((row) => row.can_write).map((row) => `${row.schema}.${row.name}`)).toEqual([]);
    const readable = rows.filter((row) => row.can_read).map((row) => `${row.schema}.${row.name}`).sort();
    expect(readable).toEqual(Object.keys(CONTRACT).map((view) => `crm.${view}`).sort());
  });

  it("cannot run any function that runs with its owner's rights (money, locks)", async () => {
    const { rows } = await sql<{ name: string }>`
      select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname not in ('pg_catalog', 'information_schema') and p.prosecdef
        and p.prorettype <> 'trigger'::regtype and has_function_privilege(${CRM_ROLE}, p.oid, 'EXECUTE')`.execute(t.admin);
    expect(rows).toEqual([]);
    expect(await codeOf(crm.query("select lock_wallet_balance(gen_random_uuid())"))).toBe("42501");
  });

  it("cannot create anything in any schema", async () => {
    const { rows } = await sql<{ name: string }>`
      select nspname as name from pg_namespace where has_schema_privilege(${CRM_ROLE}, oid, 'CREATE')`.execute(t.admin);
    expect(rows).toEqual([]);
  });

  it("is refused the tables, including the one holding contact details", async () => {
    for (const table of ["lead_contacts", "leads", "clients", "client_users", "credit_ledger", "audit_logs"]) {
      expect(await codeOf(crm.query(`select 1 from ${table} limit 1`)), table).toBe("42501");
    }
  });

  it("is read-only twice over: by default, and by privilege even inside a read-write transaction", async () => {
    expect((await crm.query("show default_transaction_read_only")).rows[0]).toEqual({ default_transaction_read_only: "on" });
    // A temporary table is the one thing every role may create, so only the read-only default can refuse it.
    expect(await codeOf(crm.query("create temp table crm_probe (a int)"))).toBe("25006");

    await crm.query("begin read write");
    try {
      expect(await codeOf(crm.query("update crm.charges_v1 set amount_pence = 0"))).toBe("42501");
    } finally {
      await crm.query("rollback");
    }
  });

  it("has short timeouts and a small connection limit, so it can never starve lead capture", async () => {
    const { rows } = await sql<{ rolconnlimit: number; rolconfig: string[] }>`
      select rolconnlimit, rolconfig from pg_roles where rolname = ${CRM_ROLE}`.execute(t.admin);
    expect(rows[0]!.rolconnlimit).toBe(5);
    expect(rows[0]!.rolconfig).toEqual(expect.arrayContaining(["statement_timeout=4s", "lock_timeout=1s", "idle_in_transaction_session_timeout=5s"]));
  });

  it("gets its grants back when the role script runs after the migration", async () => {
    await sql`revoke select on all tables in schema crm from ${sql.raw(CRM_ROLE)}`.execute(t.admin);
    expect(await codeOf(crm.query("select 1 from crm.leads_v1 limit 1"))).toBe("42501");

    // The role script is cluster-wide (ALTER ROLE) but grants in the database it runs in: run it here.
    await sql.raw(crmRoleScript()).execute(t.admin);
    expect(await codeOf(crm.query("select 1 from crm.leads_v1 limit 1"))).toBe("succeeded");
  });
});

describe("what the views show", () => {
  it("never shows a consumer's details, a business's notes or anyone's free text", async () => {
    const canary = {
      email: "zebedee.canary.4417@example.com",
      phone: "+447911455617",
      name: "Zebedee Canaryperson",
      contactNote: "canary-contact-note-5521",
      detail: "canary-detail-7731",
      postcode: "BR6 0AA",
      clientContact: "canary.business.contact@heating.example",
      outcomeNote: "canary-outcome-note-9913",
      dispute: "canary-dispute-words-3307",
    };

    const lead = await insertRawLead(t.admin, { email: canary.email, phone: canary.phone, postcode: canary.postcode });
    await sql`update lead_contacts set full_name = ${canary.name}, notes = ${canary.contactNote} where lead_id = ${lead.id}`.execute(t.admin);
    await sql`update leads set details = ${JSON.stringify({ description: canary.detail })}::jsonb where id = ${lead.id}`.execute(t.admin);

    const client = await insertRawClient(t.admin, { email: canary.clientContact });
    await sql`update clients set contact_name = ${canary.name}, contact_phone_e164 = ${canary.phone}, notes = ${canary.contactNote} where id = ${client.id}`.execute(t.admin);
    const assignment = await insertRawAssignment(t.admin, lead.id, { clientId: client.id, status: "accepted" });
    await sql`update leads set status = 'assigned' where id = ${lead.id}`.execute(t.admin);
    const { rows: users } = await sql<{ id: string }>`
      insert into client_users (client_id, email, name) values (${client.id}, ${canary.clientContact}, ${canary.name}) returning id`.execute(t.admin);
    await sql`insert into assignment_contact_attempts (assignment_id, outcome, note, job_value_pence)
              values (${assignment.id}, 'won', ${canary.outcomeNote}, 450000)`.execute(t.admin);
    await sql`insert into disputes (assignment_id, client_id, reason, description, raised_by)
              values (${assignment.id}, ${client.id}, 'other', ${canary.dispute}, ${users[0]!.id})`.execute(t.admin);

    const dump: unknown[] = [];
    for (const view of Object.keys(CONTRACT)) dump.push((await crm.query(`select * from crm.${view}`)).rows);
    const text = JSON.stringify(dump);

    // The lead, its business and its outcome ARE there (so the absence below means something)...
    expect(text).toContain(lead.reference);
    expect(text).toContain(client.id);
    expect(text).toContain("450000");
    // ...and none of the personal or free-text values are.
    for (const [what, value] of Object.entries(canary)) expect(text, what).not.toContain(value);
  });

  it("leaves out test and deleted leads, as the inbox does", async () => {
    const test = await insertRawLead(t.admin, { isTest: true });
    const deleted = await insertRawLead(t.admin);
    await sql`update leads set deleted_at = now() where id = ${deleted.id}`.execute(t.admin);
    const testAssigned = await insertRawLead(t.admin, { isTest: true, status: "assigned" });

    const { rows } = await crm.query("select id from crm.leads_v1 where id = any($1)", [[test.id, deleted.id, testAssigned.id]]);
    expect(rows).toEqual([]);
    const { rows: assignments } = await crm.query("select id from crm.assignments_v1 where lead_id = any($1)", [[testAssigned.id]]);
    expect(assignments).toEqual([]);
  });

  it("leaves test and deleted leads out of charges, disputes and outcomes, the same way the parent views do", async () => {
    const testClient = await insertRawClient(t.admin, { name: "Filter Test" });
    const deletedClient = await insertRawClient(t.admin, { name: "Filter Deleted" });
    const realClient = await insertRawClient(t.admin, { name: "Filter Real" });
    const testLead = await insertRawLead(t.admin, { isTest: true });
    const deletedLead = await insertRawLead(t.admin);
    const testAssignment = await insertRawAssignment(t.admin, testLead.id, { clientId: testClient.id, status: "accepted" });
    const deletedAssignment = await insertRawAssignment(t.admin, deletedLead.id, { clientId: deletedClient.id, status: "accepted" });
    await sql`update leads set deleted_at = now() where id = ${deletedLead.id}`.execute(t.admin);
    const { rows: users } = await sql<{ id: string }>`
      insert into client_users (client_id, email, name) values (${testClient.id}, ${testClient.email}, 'Filter Person') returning id`.execute(t.admin);
    const { rows: deletedUsers } = await sql<{ id: string }>`
      insert into client_users (client_id, email, name) values (${deletedClient.id}, ${deletedClient.email}, 'Filter Person') returning id`.execute(t.admin);
    await sql`insert into assignment_contact_attempts (assignment_id, outcome, job_value_pence) values (${testAssignment.id}, 'won', 100)`.execute(t.admin);
    await sql`insert into disputes (assignment_id, client_id, reason, description, raised_by) values (${testAssignment.id}, ${testClient.id}, 'other', 'hidden', ${users[0]!.id})`.execute(t.admin);
    await sql`insert into assignment_contact_attempts (assignment_id, outcome, job_value_pence) values (${deletedAssignment.id}, 'won', 100)`.execute(t.admin);
    await sql`insert into disputes (assignment_id, client_id, reason, description, raised_by) values (${deletedAssignment.id}, ${deletedClient.id}, 'other', 'hidden', ${deletedUsers[0]!.id})`.execute(t.admin);

    for (const assignmentId of [testAssignment.id, deletedAssignment.id]) {
      expect((await crm.query("select id from crm.charges_v1 where assignment_id = $1", [assignmentId])).rows, assignmentId).toEqual([]);
      expect((await crm.query("select id from crm.disputes_v1 where assignment_id = $1", [assignmentId])).rows, assignmentId).toEqual([]);
      expect((await crm.query("select id from crm.outcomes_v1 where assignment_id = $1", [assignmentId])).rows, assignmentId).toEqual([]);
    }

    const real = await insertRawLead(t.admin);
    const realAssignment = await insertRawAssignment(t.admin, real.id, { clientId: realClient.id, status: "accepted" });
    expect((await crm.query("select id from crm.charges_v1 where assignment_id = $1", [realAssignment.id])).rows.length).toBeGreaterThan(0);
  });

  it("agrees with the inbox on which leads need a person, lead by lead", async () => {
    const handled = async (id: string) => sql`insert into lead_events (lead_id, type) values (${id}, ${LEAD_EVENT.handled})`.execute(t.admin);

    const world: string[] = [];
    for (const status of ["new", "unroutable", "held", "invalid", "rejected_fraud", "expired"] as const) {
      const plain = await insertRawLead(t.admin, { status, fraudDecision: status === "held" ? "review" : "accept" });
      const dealtWith = await insertRawLead(t.admin, { status, fraudDecision: status === "held" ? "review" : "accept" });
      await handled(dealtWith.id);
      world.push(plain.id, dealtWith.id);
    }
    for (const assignmentStatus of ["reserved", "notified", "accepted"] as const) {
      const lead = await insertRawLead(t.admin);
      await insertRawAssignment(t.admin, lead.id, { status: assignmentStatus });
      await sql`update leads set status = 'assigned' where id = ${lead.id}`.execute(t.admin);
      world.push(lead.id);
    }

    const { rows: expected } = await sql<{ id: string; needs: boolean }>`
      select l.id, ${needsAPerson} as needs from leads l where l.id = any(${world})`.execute(t.admin);
    const { rows: actual } = await crm.query<{ id: string; needs_person: boolean }>("select id, needs_person from crm.leads_v1 where id = any($1)", [world]);

    const byId = (rows: { id: string }[], value: (row: never) => boolean) => Object.fromEntries(rows.map((row) => [row.id, value(row as never)]));
    expect(actual).toHaveLength(world.length);
    expect(byId(actual, (row: { needs_person: boolean }) => row.needs_person)).toEqual(byId(expected, (row: { needs: boolean }) => row.needs));
    // Not a vacuous agreement: the world has leads on both sides of the line.
    const needs = expected.filter((row) => row.needs).length;
    expect(needs).toBeGreaterThanOrEqual(4);
    expect(world.length - needs).toBeGreaterThanOrEqual(4);
  });
});
