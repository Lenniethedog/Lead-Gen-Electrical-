import { sql } from "kysely";
import pino from "pino";
import { createRoutingService, type RoutingService } from "../../src/modules/routing";
import type { Operator } from "../../src/modules/inbox";
import { createTestDatabase, type TestDatabase } from "./db";
import { buildStage3 } from "./stage3";

/** The stage 4 router wired as production wires it, over one private test database, with a clock a test can set. */
export async function buildRouting(options: { price?: number | null } = {}) {
  const t = await createTestDatabase();
  const s = buildStage3(t);
  const owner = await s.operator("owner@example.com", "owner");
  const staff = await s.operator("staff@example.com", "staff");
  if (options.price !== null) await s.setPrice(owner, options.price ?? 3500);

  const clock: { at?: Date } = {};
  const routing: RoutingService = createRoutingService({
    db: t.db,
    logger: pino({ level: "silent" }),
    verticalSlug: "roofing",
    isSuppressed: s.privacy.isSuppressed,
    clock: async () => clock.at ?? new Date(),
  });

  const turnOn = async (by: Operator = owner) => {
    const result = await routing.setEnabled({ operator: by, enabled: true, requestId: s.rid() });
    if (!result.ok) throw new Error(`could not enable routing: ${result.code}`);
  };

  /** Preferences a business would set (written as the owner: the clients module's own setters are tested elsewhere). */
  const prefs = async (clientId: string, values: { priority?: number; weight?: number; dailyCap?: number | null; monthlyCap?: number | null; timezone?: string }) => {
    await t.admin.updateTable("clients").set({
      ...(values.priority !== undefined && { priority: values.priority }),
      ...(values.weight !== undefined && { weight: values.weight }),
      ...(values.dailyCap !== undefined && { daily_lead_cap: values.dailyCap }),
      ...(values.monthlyCap !== undefined && { monthly_lead_cap: values.monthlyCap }),
      ...(values.timezone !== undefined && { timezone: values.timezone }),
    }).where("id", "=", clientId).execute();
  };

  const hours = async (clientId: string, windows: Array<{ weekday: number; opens: string; closes: string }>) => {
    for (const window of windows) await sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${clientId}, ${window.weekday}, ${window.opens}::time, ${window.closes}::time)`.execute(t.admin);
  };

  const pause = async (clientId: string, startsAt: Date, endsAt: Date) => {
    await sql`insert into client_pauses (client_id, starts_at, ends_at, reason) values (${clientId}, ${startsAt.toISOString()}, ${endsAt.toISOString()}, 'holiday')`.execute(t.admin);
  };

  const leadRow = (id: string) => t.admin.selectFrom("leads").select(["status", "routing_attempted_at", "sale_model", "assignments_count"]).where("id", "=", id).executeTakeFirstOrThrow();
  const runsOf = (leadId: string) => t.admin.selectFrom("routing_runs").selectAll().where("lead_id", "=", leadId).orderBy("created_at").orderBy("id").execute();
  const assignmentsOf = (leadId: string) => t.admin.selectFrom("lead_assignments").selectAll().where("lead_id", "=", leadId).orderBy("created_at").execute();
  const eventsOf = (leadId: string) => t.admin.selectFrom("lead_events").select(["type", "actor_type", "payload"]).where("lead_id", "=", leadId).orderBy("id").execute();

  /** Counts of ACTIVE assignments per business. */
  const holdings = async (): Promise<Map<string, number>> => {
    const rows = await t.admin.selectFrom("lead_assignments").select(["client_id"]).select((eb) => eb.fn.countAll<string>().as("n")).where("status", "in", ["reserved", "notified", "accepted", "disputed"]).groupBy("client_id").execute();
    return new Map(rows.map((row) => [row.client_id, Number(row.n)]));
  };

  return { t, s, owner, staff, routing, clock, turnOn, prefs, hours, pause, leadRow, runsOf, assignmentsOf, eventsOf, holdings, destroy: () => t.destroy() };
}

export type RoutingEnv = Awaited<ReturnType<typeof buildRouting>>;
export type { TestDatabase };
