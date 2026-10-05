import { sql } from "kysely";
import { LEAD_EVENT } from "@/config/lead-events";
import { ROUTING_POLICY } from "@/config/routing";
import type { Database } from "@/lib/db/client";
import type { LeadStatus, UrgencyLevel } from "@/lib/db/schema";
import type { ClientFacts, WorkingWindow } from "./engine";
import type { RuleKind, RuleRow, RuleType } from "./rules";

/** All SQL for routing. Every function takes a `Database` (possibly a transaction); the service owns transaction boundaries. */

/** The Postgres channel a lead becoming routable, or a client/price/rule changing, notifies. Only an accelerator: the worker also polls. */
export const ROUTING_CHANNEL = "routing_due";

const ACTIVE = sql`('reserved', 'notified', 'accepted', 'disputed')`;
const num = (value: string | number | null): number => (value === null ? 0 : Number(value));

// ------------------------------------------------------------------------------------------------
// Settings (the switch)
// ------------------------------------------------------------------------------------------------

export interface RoutingSettings {
  verticalId: number;
  enabled: boolean;
  enabledAt: Date | null;
  maxLeadAgeHours: number;
  pokedAt: Date;
  updatedAt: Date | null;
}

export async function getSettings(db: Database, verticalId: number): Promise<RoutingSettings> {
  const row = await db.selectFrom("routing_settings").selectAll().where("vertical_id", "=", verticalId).executeTakeFirst();
  // No row yet = never switched on = off. Reading never creates one.
  if (!row) return { verticalId, enabled: false, enabledAt: null, maxLeadAgeHours: ROUTING_POLICY.defaultMaxLeadAgeHours, pokedAt: new Date(0), updatedAt: null };
  return { verticalId, enabled: row.enabled, enabledAt: row.enabled_at, maxLeadAgeHours: row.max_lead_age_hours, pokedAt: row.poked_at, updatedAt: row.updated_at };
}

/**
 * Switches routing on or off. Turning it ON records when, and only leads that arrive from that moment are ever routed. Turning it on
 * when it is already on changes nothing (in particular it does not move `enabled_at`, which would silently exclude waiting leads).
 */
export async function saveSettings(
  db: Database,
  input: { verticalId: number; enabled: boolean; maxLeadAgeHours?: number | undefined; operatorId: string },
): Promise<void> {
  await sql`
    insert into routing_settings (vertical_id, enabled, enabled_at, max_lead_age_hours, updated_by)
    values (${input.verticalId}, ${input.enabled}, ${input.enabled ? sql`now()` : null}, ${input.maxLeadAgeHours ?? ROUTING_POLICY.defaultMaxLeadAgeHours}, ${input.operatorId})
    on conflict (vertical_id) do update set
      enabled = excluded.enabled,
      enabled_at = case when excluded.enabled and not routing_settings.enabled then now() else routing_settings.enabled_at end,
      max_lead_age_hours = ${input.maxLeadAgeHours === undefined ? sql`routing_settings.max_lead_age_hours` : sql`excluded.max_lead_age_hours`},
      updated_by = excluded.updated_by`.execute(db);
}

// ------------------------------------------------------------------------------------------------
// Rules
// ------------------------------------------------------------------------------------------------

const KIND_ORDER = sql`case r.kind when 'filter' then 0 when 'limiter' then 1 else 2 end`;

export async function listRules(db: Database, verticalId: number): Promise<RuleRow[]> {
  const { rows } = await sql<{ id: string; type: RuleType; kind: RuleKind; position: number; config: Record<string, unknown>; active: boolean; version: number }>`
    select r.id, r.type, r.kind, r.position, r.config, r.active, r.version
      from routing_rules r where r.vertical_id = ${verticalId} order by ${KIND_ORDER}, r.position, r.type`.execute(db);
  return rows;
}

export async function getRule(db: Database, verticalId: number, ruleId: string): Promise<RuleRow | undefined> {
  const { rows } = await sql<RuleRow>`
    select r.id, r.type, r.kind, r.position, r.config, r.active, r.version
      from routing_rules r where r.vertical_id = ${verticalId} and r.id = ${ruleId} for update`.execute(db);
  return rows[0];
}

/** Compare-and-set on the version the editor was looking at: a rule changed by someone else in the meantime is refused, not overwritten. */
export async function updateRule(
  db: Database,
  input: { ruleId: string; expectedVersion: number; active: boolean; config: Record<string, unknown>; operatorId: string },
): Promise<boolean> {
  const { rows } = await sql`
    update routing_rules set active = ${input.active}, config = ${JSON.stringify(input.config)}::jsonb, version = version + 1, updated_by = ${input.operatorId}
     where id = ${input.ruleId} and version = ${input.expectedVersion} returning id`.execute(db);
  return rows.length > 0;
}

/** Swaps the positions of two rules of the same kind (the unique constraint on position is deferred, so the swap is one statement). */
export async function swapPositions(db: Database, a: RuleRow, b: RuleRow, operatorId: string): Promise<void> {
  await sql`
    update routing_rules set position = case id when ${a.id} then ${b.position}::smallint else ${a.position}::smallint end,
                             version = version + 1, updated_by = ${operatorId}
     where id in (${a.id}, ${b.id})`.execute(db);
}

// ------------------------------------------------------------------------------------------------
// The work queue
// ------------------------------------------------------------------------------------------------

/**
 * A lead the router may take: it arrived while routing was on, is young enough, is not test data, has not been dealt with by a person
 * (marked handled, or taken back for a reason that needs a person), and is either `new` or `unroutable` and due another look.
 * `s` is its vertical's settings row and `l` the lead: the health check and the claim use THIS fragment, so "should have been routed"
 * means the same thing in both.
 */
export const routableLead = sql`
  s.enabled AND s.vertical_id = l.vertical_id
  AND l.deleted_at IS NULL AND l.erased_at IS NULL AND NOT l.is_test
  AND l.created_at >= s.enabled_at
  AND l.created_at > now() - make_interval(hours => s.max_lead_age_hours)
  AND NOT EXISTS (SELECT 1 FROM lead_events e WHERE e.lead_id = l.id AND e.type IN (${LEAD_EVENT.handled}, ${LEAD_EVENT.routingStopped}))
  AND (l.status = 'new'
       OR (l.status = 'unroutable'
           AND coalesce(l.routing_attempted_at, l.status_changed_at) < GREATEST(now() - make_interval(mins => ${ROUTING_POLICY.unroutableRetryMinutes}), s.poked_at)))`;

/** Cheap, lock-free: is there anything for the router to do? (The worker asks before opening a transaction.) */
export async function hasRoutableLead(db: Database, verticalId: number): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`
    select exists (select 1 from leads l join routing_settings s on s.vertical_id = l.vertical_id
                    where l.vertical_id = ${verticalId} and ${routableLead}) as found`.execute(db);
  return rows[0]?.found ?? false;
}

/** Serialises routing for a vertical: one decision at a time, so fairness and caps are exact. Released at COMMIT or ROLLBACK. */
export async function lockRouting(db: Database, verticalId: number): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('leadgen.routing'), ${verticalId})`.execute(db);
}

export interface RoutableLead {
  id: string;
  reference: string;
  status: LeadStatus;
  /** Full postcode, personal data: used to decide and never copied into a run. */
  postcode: string | null;
  postcodeOutward: string;
  verticalId: number;
  serviceTypeId: number;
  urgency: UrgencyLevel;
  saleModel: "exclusive" | "shared" | null;
}

const leadShape = (row: { id: string; reference: string; status: LeadStatus; postcode: string | null; postcode_outward: string; vertical_id: number; service_type_id: number; urgency: UrgencyLevel; sale_model: "exclusive" | "shared" | null }): RoutableLead => ({
  id: row.id, reference: row.reference, status: row.status, postcode: row.postcode, postcodeOutward: row.postcode_outward,
  verticalId: row.vertical_id, serviceTypeId: row.service_type_id, urgency: row.urgency, saleModel: row.sale_model,
});

/** Takes the oldest routable lead and locks it. SKIP LOCKED: a lead an operator has open for assignment is simply left to them. */
export async function claimNextLead(db: Database, verticalId: number): Promise<RoutableLead | undefined> {
  const { rows } = await sql<Parameters<typeof leadShape>[0]>`
    select l.id, l.reference, l.status, l.postcode, l.postcode_outward, l.vertical_id, l.service_type_id, l.urgency, l.sale_model
      from leads l join routing_settings s on s.vertical_id = l.vertical_id
     where l.vertical_id = ${verticalId} and ${routableLead}
     order by l.created_at, l.id
     limit 1
     for update of l skip locked`.execute(db);
  return rows[0] && leadShape(rows[0]);
}

/** The lead as it is NOW, locked: for the explanation of a specific lead and for the error path. */
export async function readLead(db: Database, leadId: string): Promise<(RoutableLead & { createdAt: Date; erased: boolean; handled: boolean; routingStopped: boolean }) | undefined> {
  const { rows } = await sql<Parameters<typeof leadShape>[0] & { created_at: Date; erased_at: Date | null; deleted_at: Date | null; handled: boolean; stopped: boolean }>`
    select l.id, l.reference, l.status, l.postcode, l.postcode_outward, l.vertical_id, l.service_type_id, l.urgency, l.sale_model,
           l.created_at, l.erased_at, l.deleted_at,
           exists (select 1 from lead_events e where e.lead_id = l.id and e.type = ${LEAD_EVENT.handled}) as handled,
           exists (select 1 from lead_events e where e.lead_id = l.id and e.type = ${LEAD_EVENT.routingStopped}) as stopped
      from leads l where l.id = ${leadId}`.execute(db);
  const row = rows[0];
  if (!row) return undefined;
  return { ...leadShape(row), createdAt: row.created_at, erased: row.erased_at !== null || row.deleted_at !== null, handled: row.handled, routingStopped: row.stopped };
}

export async function markAttempted(db: Database, leadId: string): Promise<void> {
  await sql`update leads set routing_attempted_at = now() where id = ${leadId}`.execute(db);
}

export async function recordLeadEvent(db: Database, input: { leadId: string; type: string; requestId: string; payload: Record<string, unknown> }): Promise<void> {
  await db
    .insertInto("lead_events")
    .values({ lead_id: input.leadId, type: input.type, actor_type: "system", request_id: input.requestId, payload: JSON.stringify(input.payload) })
    .execute();
}

/** Has the router already told the operator this lead found nobody? (So a lead retried every few minutes writes the event once.) */
export async function hasUnroutableEvent(db: Database, leadId: string): Promise<boolean> {
  const { rows } = await sql<{ found: boolean }>`select exists (select 1 from lead_events where lead_id = ${leadId} and type = ${LEAD_EVENT.unroutable}) as found`.execute(db);
  return rows[0]?.found ?? false;
}

// ------------------------------------------------------------------------------------------------
// Facts about the candidates
// ------------------------------------------------------------------------------------------------

/**
 * Everything the decision needs to know about each candidate business, read at ONE instant (`at`). The counts use the same set of
 * statuses as "holds a lead right now" (a lead that was taken back or ended does not count against a business), and the day and month
 * are the business's own (its time zone), so "daily cap" means the business's day.
 */
export async function loadClientFacts(db: Database, input: { leadId: string; clientIds: readonly string[]; at: Date; windowDays: number }): Promise<ClientFacts[]> {
  if (input.clientIds.length === 0) return [];
  const at = sql`${input.at.toISOString()}::timestamptz`;
  const ids = sql`${sql.val([...input.clientIds])}::uuid[]`;
  const { rows } = await sql<{
    id: string; name: string; priority: number; weight: number; daily_lead_cap: number | null; monthly_lead_cap: number | null;
    assigned_today: string; assigned_month: string; assigned_window: string; last_assigned_at: Date | null;
    previously_held: boolean; paused_until: Date | null; local_weekday: number; local_minutes: number;
  }>`
    select c.id, c.name, c.priority, c.weight, c.daily_lead_cap, c.monthly_lead_cap,
      (select count(*) from lead_assignments a where a.client_id = c.id and a.status in ${ACTIVE}
          and a.created_at >= (date_trunc('day', ${at} at time zone c.timezone) at time zone c.timezone)) as assigned_today,
      (select count(*) from lead_assignments a where a.client_id = c.id and a.status in ${ACTIVE}
          and a.created_at >= (date_trunc('month', ${at} at time zone c.timezone) at time zone c.timezone)) as assigned_month,
      (select count(*) from lead_assignments a where a.client_id = c.id and a.status in ${ACTIVE}
          and a.created_at >= ${at} - make_interval(days => ${input.windowDays})) as assigned_window,
      (select max(a.created_at) from lead_assignments a where a.client_id = c.id and a.status in ${ACTIVE}) as last_assigned_at,
      exists (select 1 from lead_assignments a where a.client_id = c.id and a.lead_id = ${input.leadId}) as previously_held,
      (select max(p.ends_at) from client_pauses p where p.client_id = c.id and p.starts_at <= ${at} and p.ends_at > ${at}) as paused_until,
      extract(dow from (${at} at time zone c.timezone))::int as local_weekday,
      (extract(hour from (${at} at time zone c.timezone)) * 60 + extract(minute from (${at} at time zone c.timezone)))::int as local_minutes
      from clients c
     where c.id = any(${ids})`.execute(db);

  const { rows: hourRows } = await sql<{ client_id: string; weekday: number; opens_m: number; closes_m: number }>`
    select client_id, weekday,
           (extract(hour from opens) * 60 + extract(minute from opens))::int as opens_m,
           (extract(hour from closes) * 60 + extract(minute from closes))::int as closes_m
      from client_working_hours where client_id = any(${ids}) order by client_id, weekday, opens`.execute(db);
  const hoursBy = new Map<string, WorkingWindow[]>();
  for (const row of hourRows) {
    const list = hoursBy.get(row.client_id) ?? [];
    list.push({ weekday: row.weekday, opensMinutes: row.opens_m, closesMinutes: row.closes_m });
    hoursBy.set(row.client_id, list);
  }

  return rows.map((row): ClientFacts => ({
    clientId: row.id, name: row.name, priority: row.priority, weight: row.weight,
    dailyCap: row.daily_lead_cap, monthlyCap: row.monthly_lead_cap,
    assignedToday: num(row.assigned_today), assignedThisMonth: num(row.assigned_month), assignedInWindow: num(row.assigned_window),
    lastAssignedAt: row.last_assigned_at, hours: hoursBy.get(row.id) ?? [],
    localWeekday: row.local_weekday, localMinutes: row.local_minutes, pausedUntil: row.paused_until, previouslyHeld: row.previously_held,
  }));
}

/** Locks one business against changes (a pause, a status change, a lost coverage rule) for the rest of the transaction, and says whether it is still active. */
export async function lockClientForRouting(db: Database, clientId: string): Promise<{ status: string } | undefined> {
  const row = await db.selectFrom("clients").select(["status"]).where("id", "=", clientId).where("deleted_at", "is", null).forShare().executeTakeFirst();
  return row;
}

// ------------------------------------------------------------------------------------------------
// Runs (the record)
// ------------------------------------------------------------------------------------------------

export type RunOutcome = "assigned" | "no_candidates" | "error" | "skipped";

export interface RunInput {
  leadId: string;
  outcome: RunOutcome;
  rules: unknown;
  algorithmVersion: string;
  candidates: unknown;
  chosenClientId: string | null;
  pricePence: number | null;
  error: string | null;
  durationMs: number;
}

export async function insertRun(db: Database, run: RunInput): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into routing_runs (lead_id, outcome, rules, algorithm_version, candidates, chosen_client_id, price_pence, error, duration_ms)
    values (${run.leadId}, ${run.outcome}::routing_outcome, ${JSON.stringify(run.rules)}::jsonb, ${run.algorithmVersion}, ${JSON.stringify(run.candidates)}::jsonb,
            ${run.chosenClientId}, ${run.pricePence}, ${run.error}, ${Math.max(0, Math.round(run.durationMs))})
    returning id`.execute(db);
  return rows[0]!.id;
}

export interface StoredRun {
  id: string;
  leadId: string;
  reference: string;
  outcome: RunOutcome;
  createdAt: Date;
  durationMs: number | null;
  chosenClientId: string | null;
  chosenClientName: string | null;
  pricePence: number | null;
  error: string | null;
  rules: unknown;
  candidates: unknown;
}

const runSelect = sql`
  select r.id, r.lead_id, l.reference, r.outcome, r.created_at, r.duration_ms, r.chosen_client_id, c.name as chosen_client_name,
         r.price_pence, r.error, r.rules, r.candidates
    from routing_runs r join leads l on l.id = r.lead_id left join clients c on c.id = r.chosen_client_id`;

type RunRow = { id: string; lead_id: string; reference: string; outcome: RunOutcome; created_at: Date; duration_ms: number | null; chosen_client_id: string | null; chosen_client_name: string | null; price_pence: number | null; error: string | null; rules: unknown; candidates: unknown };
const toRun = (row: RunRow): StoredRun => ({
  id: row.id, leadId: row.lead_id, reference: row.reference, outcome: row.outcome, createdAt: row.created_at, durationMs: row.duration_ms,
  chosenClientId: row.chosen_client_id, chosenClientName: row.chosen_client_name, pricePence: row.price_pence, error: row.error, rules: row.rules, candidates: row.candidates,
});

export async function runsForLead(db: Database, leadId: string, limit = 20): Promise<StoredRun[]> {
  const { rows } = await sql<RunRow>`${runSelect} where r.lead_id = ${leadId} order by r.created_at desc, r.id limit ${limit}`.execute(db);
  return rows.map(toRun);
}

export async function recentRuns(db: Database, limit = 50): Promise<StoredRun[]> {
  const { rows } = await sql<RunRow>`${runSelect} order by r.created_at desc, r.id limit ${limit}`.execute(db);
  return rows.map(toRun);
}

export async function getRun(db: Database, runId: string): Promise<StoredRun | undefined> {
  const { rows } = await sql<RunRow>`${runSelect} where r.id = ${runId}`.execute(db);
  return rows[0] && toRun(rows[0]);
}

export interface RoutingStats {
  windowHours: number;
  runs: number;
  assigned: number;
  noCandidates: number;
  errors: number;
  skipped: number;
  /** Over runs that finished in the window. Null when there were none. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  /** Leads the router has found nobody for, right now. */
  unroutableNow: number;
}

export async function routingStats(db: Database, windowHours = 24): Promise<RoutingStats> {
  const { rows } = await sql<{ runs: string; assigned: string; no_candidates: string; errors: string; skipped: string; p50: number | null; p95: number | null; max: number | null; unroutable: string }>`
    select count(*) as runs,
           count(*) filter (where outcome = 'assigned') as assigned,
           count(*) filter (where outcome = 'no_candidates') as no_candidates,
           count(*) filter (where outcome = 'error') as errors,
           count(*) filter (where outcome = 'skipped') as skipped,
           percentile_cont(0.5) within group (order by duration_ms)::float8 as p50,
           percentile_cont(0.95) within group (order by duration_ms)::float8 as p95,
           max(duration_ms)::float8 as max,
           (select count(*) from leads where status = 'unroutable' and deleted_at is null and not is_test) as unroutable
      from routing_runs where created_at > now() - make_interval(hours => ${windowHours})`.execute(db);
  const row = rows[0]!;
  return {
    windowHours, runs: num(row.runs), assigned: num(row.assigned), noCandidates: num(row.no_candidates), errors: num(row.errors), skipped: num(row.skipped),
    p50Ms: row.p50, p95Ms: row.p95, maxMs: row.max, unroutableNow: num(row.unroutable),
  };
}

// ------------------------------------------------------------------------------------------------
// Health
// ------------------------------------------------------------------------------------------------

export type RoutingProblem = "routing_stalled" | "routing_failing";

export interface RoutingHealth {
  ok: boolean;
  problems: RoutingProblem[];
}

/**
 * Is routing doing its job RIGHT NOW? Only meaningful while it is switched on (a switched-off router has nothing to do and is
 * never "stalled"). Counts only: it feeds a public endpoint.
 */
export async function getRoutingHealth(db: Database): Promise<RoutingHealth> {
  const { rows } = await sql<{ stalled: boolean; failing: boolean }>`
    select exists (select 1 from leads l join routing_settings s on s.vertical_id = l.vertical_id
                    where l.status = 'new' and ${routableLead}
                      and l.created_at < now() - make_interval(secs => ${ROUTING_POLICY.stalledSeconds})) as stalled,
           exists (select 1 from routing_runs r join routing_settings s on s.enabled
                    where r.outcome = 'error' and r.created_at > now() - make_interval(mins => ${ROUTING_POLICY.failingWindowMinutes})) as failing`.execute(db);
  const row = rows[0]!;
  const problems: RoutingProblem[] = [];
  if (row.stalled) problems.push("routing_stalled");
  if (row.failing) problems.push("routing_failing");
  return { ok: problems.length === 0, problems };
}
