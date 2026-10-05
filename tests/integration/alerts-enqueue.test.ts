import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALERTS_CHANNEL, enqueueOperatorAlert } from "../../src/modules/alerts";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildLeadService, command, FakeChallenge, validSubmission } from "../helpers/fixtures";
import { insertRawLead } from "../helpers/raw";

/**
 * The first half of the "no lead is ever left unseen" guarantee: the alert row is created in the
 * SAME transaction as the lead, so there is no window in which a lead exists but nobody will be told.
 */
let t: TestDatabase;
let n = 5_000;
const next = () => (n += 1);

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

const alertsOf = (leadId: string) =>
  t.admin.selectFrom("operator_alerts").selectAll().where("lead_id", "=", leadId).orderBy("kind").execute();

describe("alerts are enqueued with the lead", () => {
  it("creates exactly one pending new_lead alert, due immediately, for an accepted lead", async () => {
    const result = await buildLeadService(t.db).submit(command(validSubmission({}, next())));
    expect(result.status).toBe("new");

    const alerts = await alertsOf(result.leadId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "new_lead", status: "pending", attempt_count: 0, max_attempts: 8, locked_until: null, sent_at: null });
    expect(alerts[0]!.next_attempt_at.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("creates a held_lead alert for a lead held for review", async () => {
    const result = await buildLeadService(t.db, new FakeChallenge({ status: "missing" })).submit(command(validSubmission({}, next())));
    expect(result.status).toBe("held");
    expect((await alertsOf(result.leadId)).map((alert) => alert.kind)).toEqual(["held_lead"]);
  });

  it("does not alert for a duplicate or a fraud-rejected lead: nobody needs to act on them", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const original = await service.submit(command(validSubmission({}, k)));
    const duplicate = await service.submit(command(validSubmission({}, k)));
    expect(duplicate.status).toBe("duplicate");
    const bot = await service.submit(command(validSubmission({ context: { honeypot: "http://spam.example" } }, next())));
    expect(bot.status).toBe("rejected_fraud");

    expect(await alertsOf(original.leadId)).toHaveLength(1);
    expect(await alertsOf(duplicate.leadId)).toHaveLength(0);
    expect(await alertsOf(bot.leadId)).toHaveLength(0);
  });

  it("a retry with the same idempotency key does not create a second alert", async () => {
    const service = buildLeadService(t.db);
    const cmd = command(validSubmission({}, next()));
    const first = await service.submit(cmd);
    const retry = await service.submit(cmd);
    expect(retry.outcome).toBe("replayed");
    expect(await alertsOf(first.leadId)).toHaveLength(1);
  });

  it("12 simultaneous identical submissions leave exactly one lead and exactly one alert", async () => {
    const service = buildLeadService(t.db);
    const cmd = command(validSubmission({}, next()));
    const results = await Promise.all(Array.from({ length: 12 }, () => service.submit(cmd)));
    const leadIds = new Set(results.map((result) => result.leadId));
    expect(leadIds.size).toBe(1);
    expect(await alertsOf([...leadIds][0]!)).toHaveLength(1);
  });

  it("one alert per lead even when 8 people submit the same job at once (7 are duplicates)", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const results = await Promise.all(Array.from({ length: 8 }, () => service.submit(command(validSubmission({}, k)))));
    const live = results.filter((result) => result.status === "new");
    expect(live).toHaveLength(1);
    const total = await t.admin
      .selectFrom("operator_alerts")
      .innerJoin("leads", "leads.id", "operator_alerts.lead_id")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("leads.id", "in", results.map((result) => result.leadId))
      .executeTakeFirstOrThrow();
    expect(Number(total.n)).toBe(1);
  });

  it("is idempotent per lead and kind", async () => {
    const lead = await insertRawLead(t.admin);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    expect(await alertsOf(lead.id)).toHaveLength(1);
  });
});

describe("the alert commits or rolls back with the lead, and wakes the worker only on commit", () => {
  it("leaves no alert behind when the transaction rolls back", async () => {
    const lead = await insertRawLead(t.admin);
    await expect(
      t.db.transaction().execute(async (trx) => {
        await enqueueOperatorAlert(trx, { id: lead.id, status: "new" });
        throw new Error("something later in the lead transaction failed");
      }),
    ).rejects.toThrow("something later");
    expect(await alertsOf(lead.id)).toHaveLength(0);
  });

  it("sends the wake-up NOTIFY only when the transaction commits", async () => {
    const listener = new Client({ connectionString: t.ownerUrl });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (message) => received.push(message.channel));
    await listener.query(`listen ${ALERTS_CHANNEL}`);
    try {
      const rolledBack = await insertRawLead(t.admin);
      await t.db.transaction().execute(async (trx) => {
        await enqueueOperatorAlert(trx, { id: rolledBack.id, status: "new" });
        throw new Error("rollback");
      }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(received).toEqual([]);

      const committed = await insertRawLead(t.admin);
      await t.db.transaction().execute((trx) => enqueueOperatorAlert(trx, { id: committed.id, status: "new" }));
      await expect.poll(() => received.length, { timeout: 2_000 }).toBeGreaterThan(0);
      expect(received[0]).toBe(ALERTS_CHANNEL);
    } finally {
      await listener.end();
    }
  });

  it("ignores statuses that need no human", async () => {
    for (const status of ["duplicate", "rejected_fraud", "invalid", "expired", "assigned", "routing", "unroutable"] as const) {
      const lead = await insertRawLead(t.admin);
      await enqueueOperatorAlert(t.db, { id: lead.id, status });
      expect(await alertsOf(lead.id)).toHaveLength(0);
    }
  });
});

describe("the database shape of an alert", () => {
  it("cannot be deleted by the application role, and attempts are append-only", async () => {
    const lead = await insertRawLead(t.admin);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    const alert = (await alertsOf(lead.id))[0]!;
    await expect(t.db.deleteFrom("operator_alerts").where("id", "=", alert.id).execute()).rejects.toMatchObject({ code: "42501" });

    await t.admin
      .insertInto("operator_alert_attempts")
      .values({ alert_id: alert.id, attempt_no: 1, started_at: new Date(), outcome: "accepted", latency_ms: 5 })
      .execute();
    await expect(t.admin.updateTable("operator_alert_attempts").set({ latency_ms: 1 }).where("alert_id", "=", alert.id).execute()).rejects.toMatchObject({
      code: "23514",
    });
    await expect(t.admin.deleteFrom("operator_alert_attempts").where("alert_id", "=", alert.id).execute()).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses inconsistent states: sent without a timestamp, sending without a lease, too many attempts", async () => {
    const lead = await insertRawLead(t.admin);
    await enqueueOperatorAlert(t.db, { id: lead.id, status: "new" });
    const id = (await alertsOf(lead.id))[0]!.id;
    await expect(t.admin.updateTable("operator_alerts").set({ status: "sent" }).where("id", "=", id).execute()).rejects.toMatchObject({ code: "23514" });
    await expect(t.admin.updateTable("operator_alerts").set({ status: "sending" }).where("id", "=", id).execute()).rejects.toMatchObject({ code: "23514" });
    await expect(t.admin.updateTable("operator_alerts").set({ attempt_count: 9 }).where("id", "=", id).execute()).rejects.toMatchObject({ code: "23514" });
  });
});
