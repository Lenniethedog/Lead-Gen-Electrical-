import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "../../src/lib/db/client";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawLead } from "../helpers/raw";

/**
 * Proves the exclusivity, shared-cap, money and invariant guarantees. The assignment core, coverage rules, pricing, audit log
 * and suppressions are REAL migrations since stage 3 (0003); the rest (money, disputes, funnel view) is the
 * DESIGN in docs/design/target-schema.sql, applied on top below, so it cannot rot.
 *
 * Proves the DESIGN in docs/design/target-schema.sql, not just that it parses: the guarantees the
 * business depends on (never sell an exclusive lead twice, never share beyond consent, never charge
 * twice, never overdraw, never over-spend an allowance) must hold when many writers race.
 * Each race below uses its own connection per writer against a real PostgreSQL.
 */

const root = path.resolve(import.meta.dirname, "../..");
let t: TestDatabase;
let pool: Database;
let verticalId: number;
let multiConsentId: number;
let counter = 0;

beforeAll(async () => {
  t = await createTestDatabase();
  const ddl = await readFile(path.join(root, "docs/design/target-schema.sql"), "utf8");
  await sql.raw(ddl).execute(t.admin);
  pool = createDb({ url: t.ownerUrl, poolMax: 20 });
  verticalId = (await t.admin.selectFrom("verticals").select("id").executeTakeFirstOrThrow()).id;
  // The seeded consent allows ONE business. Shared-lead tests need wording that allows several (the database
  // refuses a recipient cap above what the consumer consented to).
  multiConsentId = (
    await t.admin
      .insertInto("consent_texts")
      .values({ code: "lead_share", version: "v900", body: "Test wording for up to five businesses.", body_sha256: "a".repeat(64), recipient_model: "shared_multiple", max_recipients: 5, channels: ["phone"] })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
});
afterAll(async () => {
  await pool.destroy();
  await t.destroy();
});

interface PgError {
  code?: string;
  constraint?: string;
  message?: string;
}
const errorOf = (result: PromiseSettledResult<unknown>): PgError => (result.status === "rejected" ? (result.reason as PgError) : {});
const failures = (results: PromiseSettledResult<unknown>[]) => results.filter((r) => r.status === "rejected");

async function makeClient(): Promise<string> {
  counter += 1;
  const { rows } = await sql<{ id: string }>`
    insert into clients (vertical_id, name, contact_email, status)
    values (${verticalId}, ${`Client ${counter}`}, ${`client${counter}@example.com`}, 'active') returning id`.execute(pool);
  return rows[0]!.id;
}

async function makeLead(model: "exclusive" | "shared" | null, maxAssignments = 1): Promise<string> {
  const lead = await insertRawLead(t.admin, maxAssignments > 1 ? { consentTextId: multiConsentId } : {});
  await sql`update leads set sale_model = ${model}::sale_type, max_assignments = ${maxAssignments} where id = ${lead.id}`.execute(pool);
  return lead.id;
}

// Every automatic assignment is explained by a routing run (a check constraint since stage 4), so each insert makes one first.
const assign = (leadId: string, clientId: string, saleType: "exclusive" | "shared" = "exclusive") =>
  sql`with run as (
        insert into routing_runs (lead_id, outcome, rules, algorithm_version, chosen_client_id)
        values (${leadId}, 'assigned', '[]'::jsonb, 'test-fixture', ${clientId}) returning id)
      insert into lead_assignments (lead_id, client_id, sale_type, assigned_by, routing_run_id, price_pence)
      select ${leadId}, ${clientId}, ${saleType}::sale_type, 'router', run.id, 3500 from run returning id`.execute(pool);

async function activeAssignments(leadId: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*) n from lead_assignments where lead_id = ${leadId} and status in ('reserved','notified','accepted','disputed')`.execute(pool);
  return Number(rows[0]!.n);
}
async function storedCount(leadId: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`select assignments_count n from leads where id = ${leadId}`.execute(pool);
  return rows[0]!.n;
}

describe("exclusive leads can never be sold twice", () => {
  it("lets exactly ONE of 12 simultaneous routers win, whoever they are", async () => {
    const leadId = await makeLead("exclusive");
    const clients = await Promise.all(Array.from({ length: 12 }, makeClient));

    const results = await Promise.allSettled(clients.map((clientId) => assign(leadId, clientId)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const failure of failures(results)) {
      expect(errorOf(failure)).toMatchObject({ code: "23505", constraint: "lead_assignments_one_active_exclusive" });
    }
    expect(await activeAssignments(leadId)).toBe(1);
    expect(await storedCount(leadId)).toBe(1);
  });

  it("frees the lead when the assignment ends, and a different client can then take it", async () => {
    const leadId = await makeLead("exclusive");
    const [first, second] = [await makeClient(), await makeClient()];
    const { rows } = await assign(leadId, first);
    const assignmentId = (rows[0] as { id: string }).id;

    await expect(assign(leadId, second)).rejects.toMatchObject({ code: "23505" });
    await sql`update lead_assignments set status = 'delivery_failed' where id = ${assignmentId}`.execute(pool);
    expect(await storedCount(leadId)).toBe(0);
    await assign(leadId, second);
    expect(await activeAssignments(leadId)).toBe(1);
  });

  it("will not let a shared assignment attach to an exclusive lead, or any assignment to an uncommitted lead", async () => {
    const exclusive = await makeLead("exclusive");
    const uncommitted = await makeLead(null);
    const client = await makeClient();
    await expect(assign(exclusive, client, "shared")).rejects.toMatchObject({ code: "23503", constraint: "lead_assignments_lead_model_fk" });
    await expect(assign(uncommitted, client, "exclusive")).rejects.toMatchObject({ code: "23503" });
  });

  it("will not let a lead change its sale model once assigned", async () => {
    const leadId = await makeLead("exclusive");
    await assign(leadId, await makeClient());
    await expect(sql`update leads set sale_model = 'shared' where id = ${leadId}`.execute(pool)).rejects.toMatchObject({ code: "23503" });
  });

  it("will not mark a lead exclusive while it allows several recipients", async () => {
    const lead = await insertRawLead(t.admin, { consentTextId: multiConsentId });
    await expect(sql`update leads set sale_model = 'exclusive', max_assignments = 3 where id = ${lead.id}`.execute(pool)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("shared leads can never exceed the number of recipients the consumer agreed to", () => {
  it("lets exactly the cap through when 10 clients race for a lead capped at 3", async () => {
    const leadId = await makeLead("shared", 3);
    const clients = await Promise.all(Array.from({ length: 10 }, makeClient));

    const results = await Promise.allSettled(clients.map((clientId) => assign(leadId, clientId, "shared")));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const failure of failures(results)) {
      // A cap violation, never a deadlock or a silent over-share.
      expect(errorOf(failure)).toMatchObject({ code: "23514", constraint: "leads_assignments_within_cap_chk" });
    }
    expect(await activeAssignments(leadId)).toBe(3);
    expect(await storedCount(leadId)).toBe(3);
  });

  it("never gives the same client the same lead twice", async () => {
    const leadId = await makeLead("shared", 3);
    const client = await makeClient();
    const results = await Promise.allSettled([assign(leadId, client, "shared"), assign(leadId, client, "shared"), assign(leadId, client, "shared")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(errorOf(failures(results)[0]!)).toMatchObject({ code: "23505", constraint: "lead_assignments_one_active_per_client" });
  });
});

describe("assignment lifecycle", () => {
  it("records history automatically and rejects illegal transitions", async () => {
    const leadId = await makeLead("exclusive");
    const { rows } = await assign(leadId, await makeClient());
    const id = (rows[0] as { id: string }).id;

    await sql`update lead_assignments set status = 'notified' where id = ${id}`.execute(pool);
    await sql`update lead_assignments set status = 'accepted' where id = ${id}`.execute(pool);
    await expect(sql`update lead_assignments set status = 'reserved' where id = ${id}`.execute(pool)).rejects.toMatchObject({ code: "23514" });
    await expect(sql`update lead_assignments set status = 'expired' where id = ${id}`.execute(pool)).rejects.toMatchObject({ code: "23514" });

    const history = await sql<{ from_status: string | null; to_status: string }>`select from_status, to_status from lead_assignment_status_history where assignment_id = ${id} order by id`.execute(pool);
    expect(history.rows).toEqual([
      { from_status: null, to_status: "reserved" },
      { from_status: "reserved", to_status: "notified" },
      { from_status: "notified", to_status: "accepted" },
    ]);
  });

  it("makes ended assignments terminal", async () => {
    const leadId = await makeLead("exclusive");
    const { rows } = await assign(leadId, await makeClient());
    const id = (rows[0] as { id: string }).id;
    await pool.transaction().execute(async (trx) => {
      await sql`select set_config('app.actor_type', 'system', true)`.execute(trx); // ending an assignment needs an actor (migration 0003)
      await sql`update lead_assignments set status = 'cancelled' where id = ${id}`.execute(trx);
    });
    await expect(sql`update lead_assignments set status = 'reserved' where id = ${id}`.execute(pool)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("money cannot go wrong silently", () => {
  async function assignmentFor(client: string) {
    const leadId = await makeLead("exclusive");
    const { rows } = await assign(leadId, client);
    return (rows[0] as { id: string }).id;
  }

  it("charges an assignment exactly once even if two workers try at the same moment", async () => {
    const client = await makeClient();
    const assignmentId = await assignmentFor(client);
    const charge = () =>
      sql`insert into lead_charges (assignment_id, client_id, amount_pence, source) values (${assignmentId}, ${client}, 3500, 'invoice')`.execute(pool);
    const results = await Promise.allSettled([charge(), charge(), charge(), charge()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(errorOf(failures(results)[0]!)).toMatchObject({ code: "23505" });
  });

  it("forbids a wallet from going negative, even under a race of withdrawals", async () => {
    const client = await makeClient();
    await sql`insert into client_wallets (client_id, balance_pence) values (${client}, 10000)`.execute(pool);
    const withdraw = () => sql`update client_wallets set balance_pence = balance_pence - 3500 where client_id = ${client}`.execute(pool);

    const results = await Promise.allSettled(Array.from({ length: 6 }, withdraw));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2); // 10000 funds exactly two 3500 charges
    for (const failure of failures(results)) expect(errorOf(failure)).toMatchObject({ code: "23514" });
    const { rows } = await sql<{ balance_pence: string }>`select balance_pence from client_wallets where client_id = ${client}`.execute(pool);
    expect(Number(rows[0]!.balance_pence)).toBe(3000);
  });

  it("will not spend more than a subscription's included allowance when charges race", async () => {
    const client = await makeClient();
    const plan = await sql<{ id: string }>`insert into plans (code, name, included_leads) values (${`plan_${counter}`}, 'Starter', 3) returning id`.execute(pool);
    const sub = await sql<{ id: string }>`insert into subscriptions (client_id, plan_id, status, current_period_start, current_period_end)
      values (${client}, ${plan.rows[0]!.id}, 'active', now(), now() + interval '30 days') returning id`.execute(pool);
    const period = await sql<{ id: string }>`insert into subscription_periods (subscription_id, period, included_leads)
      values (${sub.rows[0]!.id}, tstzrange(now(), now() + interval '30 days'), 3) returning id`.execute(pool);
    const draw = () => sql`update subscription_periods set leads_used = leads_used + 1 where id = ${period.rows[0]!.id}`.execute(pool);

    const results = await Promise.allSettled(Array.from({ length: 8 }, draw));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const failure of failures(results)) expect(errorOf(failure)).toMatchObject({ code: "23514" });
  });

  it("applies a ledger entry only once per business event, and never lets it be edited", async () => {
    const client = await makeClient();
    const post = () =>
      sql`insert into credit_ledger (client_id, entry_type, amount_pence, balance_after_pence, idempotency_key)
          values (${client}, 'top_up', 5000, 5000, ${`stripe:evt_${counter}`})`.execute(pool);
    const results = await Promise.allSettled([post(), post(), post()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(sql`update credit_ledger set amount_pence = 1 where client_id = ${client}`.execute(pool)).rejects.toMatchObject({ code: "23514" });
    await expect(sql`delete from credit_ledger where client_id = ${client}`.execute(pool)).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects ledger entries whose sign contradicts their type", async () => {
    const client = await makeClient();
    await expect(
      sql`insert into credit_ledger (client_id, entry_type, amount_pence, balance_after_pence, idempotency_key) values (${client}, 'lead_charge', 3500, 3500, 'bad-sign')`.execute(pool),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows one open dispute per assignment and processes a replayed provider event once", async () => {
    const client = await makeClient();
    const assignmentId = await assignmentFor(client);
    const dispute = () => sql`insert into disputes (assignment_id, client_id, reason) values (${assignmentId}, ${client}, 'wrong_number')`.execute(pool);
    const results = await Promise.allSettled([dispute(), dispute()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);

    const event = () => sql`insert into provider_events (provider, event_id, status) values ('twilio', 'SMreplay:delivered', 'delivered')`.execute(pool);
    const replays = await Promise.allSettled([event(), event(), event()]);
    expect(replays.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("allows a client only ONE live subscription, and no overlapping allowance periods", async () => {
    const client = await makeClient();
    const plan = await sql<{ id: string }>`insert into plans (code, name) values (${`plan_b_${counter}`}, 'Basic') returning id`.execute(pool);
    const subscribe = () =>
      sql<{ id: string }>`insert into subscriptions (client_id, plan_id, status, current_period_start, current_period_end)
        values (${client}, ${plan.rows[0]!.id}, 'active', now(), now() + interval '30 days') returning id`.execute(pool);
    const results = await Promise.allSettled([subscribe(), subscribe()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    // Racing exclusion constraints surface as 23P01 (exclusion violation) OR 40P01 (the two inserts see each
    // other and Postgres aborts one as a deadlock). Either way exactly one wins; the application treats
    // 40P01/40001 as retryable (docs/03-routing-and-delivery.md).
    expect(["23P01", "40P01"]).toContain(errorOf(failures(results)[0]!).code);
  });
});

describe("the remaining invariants", () => {
  it("makes a notification unique per assignment and channel (real table since stage 5)", async () => {
    const client = await makeClient();
    const leadId = await makeLead("exclusive");
    const { rows } = await assign(leadId, client);
    const assignmentId = (rows[0] as { id: string }).id;
    const notify = () =>
      sql`insert into notifications (assignment_id, channel) values (${assignmentId}, 'sms')`.execute(pool);
    const results = await Promise.allSettled([notify(), notify(), notify()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  it("requires coverage rules to populate exactly the fields of their kind", async () => {
    const client = await makeClient();
    await sql`insert into client_service_areas (client_id, kind, outward) values (${client}, 'outward', 'BR6')`.execute(pool);
    await sql`insert into client_service_areas (client_id, kind, center_postcode, radius_m) values (${client}, 'radius', 'BR6 0AA', 15000)`.execute(pool);
    for (const bad of [
      sql`insert into client_service_areas (client_id, kind) values (${client}, 'outward')`,
      sql`insert into client_service_areas (client_id, kind, outward, sector) values (${client}, 'outward', 'BR6', 'BR6 0')`,
      sql`insert into client_service_areas (client_id, kind, center_postcode) values (${client}, 'radius', 'BR6 0AA')`,
      sql`insert into client_service_areas (client_id, kind, center_postcode, radius_m) values (${client}, 'radius', 'BR6 0AA', 10)`,
      sql`insert into client_service_areas (client_id, kind, outward) values (${client}, 'outward', 'BR6')`, // duplicate rule
    ]) {
      await expect(bad.execute(pool)).rejects.toMatchObject({ code: expect.stringMatching(/^23/) });
    }
  });

  it("keeps client-login emails lower-case and unique among live users", async () => {
    await expect(sql`insert into users (email, name) values ('Client@Example.com', 'Client')`.execute(pool)).rejects.toMatchObject({ code: "23514" });
    await sql`insert into users (email, name) values ('client.login@example.com', 'Client')`.execute(pool);
    await expect(sql`insert into users (email, name) values ('client.login@example.com', 'Again')`.execute(pool)).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps the audit log append-only", async () => {
    await sql`insert into audit_logs (actor_type, action, entity_type, entity_id, reason) values ('staff_user', 'lead.reassign', 'lead', 'x', 'test')`.execute(pool);
    await expect(sql`update audit_logs set reason = 'edited'`.execute(pool)).rejects.toMatchObject({ code: "23514" });
    await expect(sql`delete from audit_logs`.execute(pool)).rejects.toMatchObject({ code: "23514" });
  });

  it("computes the campaign funnel view (spend, leads, CPL, ROAS)", async () => {
    const campaign = await sql<{ id: string }>`insert into ad_campaigns (platform, external_id, name) values ('google_ads', '123', 'Roof repair BR6') returning id`.execute(pool);
    const campaignId = campaign.rows[0]!.id;
    const lead = await insertRawLead(t.admin);
    await sql`insert into lead_attributions (lead_id, campaign_id) values (${lead.id}, ${campaignId})`.execute(pool);
    await sql`insert into ad_spend_daily (campaign_id, spend_date, clicks, cost_pence) values (${campaignId}, current_date, 40, 5000)`.execute(pool);

    const { rows } = await sql<{ leads: string; spend_pence: string; cost_per_lead_pence: string; roas: string }>`select leads, spend_pence, cost_per_lead_pence, roas from v_campaign_funnel_daily where campaign_id = ${campaignId}`.execute(pool);
    expect(rows[0]).toMatchObject({ leads: "1", spend_pence: "5000" });
    expect(Number(rows[0]!.cost_per_lead_pence)).toBe(5000);
    expect(Number(rows[0]!.roas)).toBe(0);
  });
});
