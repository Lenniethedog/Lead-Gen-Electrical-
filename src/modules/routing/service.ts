import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Logger } from "pino";
import { LEAD_EVENT } from "@/config/lead-events";
import { ROUTING_ALGORITHM_VERSION, ROUTING_POLICY } from "@/config/routing";
import { setSystemContext } from "@/lib/db/audit-context";
import type { Database } from "@/lib/db/client";
import { commitExclusive, consentState, insertRoutedAssignment, transitionLead } from "@/modules/assignments";
import { writeAudit } from "@/modules/audit";
import { explainCoverage, type CoverageQuery, type NotEligibleReason } from "@/modules/coverage";
import type { Operator } from "@/modules/inbox";
import { resolvePrice } from "@/modules/pricing";
import { decide, evaluateClient, type ClientFacts, type Decision, type RankedVerdict } from "./engine";
import {
  claimNextLead,
  getRule,
  getSettings,
  hasRoutableLead,
  hasUnroutableEvent,
  insertRun,
  listRules,
  loadClientFacts,
  lockClientForRouting,
  lockRouting,
  markAttempted,
  readLead,
  recentRuns,
  recordLeadEvent,
  routingStats,
  runsForLead,
  saveSettings,
  swapPositions,
  updateRule,
  type RoutableLead,
  type RoutingSettings,
  type RoutingStats,
  type RunOutcome,
  type StoredRun,
} from "./repo";
import { RULE_INFO, RULE_KIND, compileRules, fairnessWindowDays, parseRuleConfig, RulesConfigError, type CompiledRules, type RuleRow } from "./rules";


// ------------------------------------------------------------------------------------------------
// Types
// ------------------------------------------------------------------------------------------------

export interface RoutingServiceDeps {
  db: Database;
  logger: Logger;
  verticalSlug: string;
  /** Has the consumer behind this lead asked us to stop since they enquired? (Implemented by the privacy module.) */
  isSuppressed: (db: Database, leadId: string) => Promise<boolean>;
  /** Tests only: the instant a decision is made at. Default: the database's clock. */
  clock?: (db: Database) => Promise<Date>;
}

/** What the router (and the "explain" page) found out about one candidate. Stored on every run. */
export interface CandidateRecord extends RankedVerdict {
  /** `chosen`, or why a ranked business was passed over after the lock was taken. */
  result?: "chosen" | "changed_while_routing";
}

export interface RunDetail {
  lead: { reference: string; postcodeOutward: string; serviceTypeId: number; urgency: string };
  coverage: { clients: number; covered: number };
  price: { pence: number; ruleId: string | null } | null;
  /** Businesses that cover the lead, with the verdict and rank of each. */
  clients: CandidateRecord[];
  /** Businesses that do not (coverage, service, sale type, status), with every reason. */
  notCovered: Array<{ clientId: string; name: string; reasons: NotEligibleReason[] }>;
  at: string;
}

export interface Analysis {
  detail: RunDetail;
  decision: Decision;
  rules: CompiledRules;
  facts: ClientFacts[];
}

export type RouteOutcome = RunOutcome;
export interface RouteResult {
  leadId: string;
  reference: string;
  outcome: RouteOutcome;
  clientId?: string;
  runId?: string;
  /** Why nothing was assigned: a short code. */
  reason?: string;
  durationMs: number;
}

export type RoutingFailure = "forbidden" | "not_found" | "stale" | "invalid_config" | "cannot_move" | "invalid_age";
export type RoutingResult<T = object> = ({ ok: true } & T) | { ok: false; code: RoutingFailure; message?: string };

export type Blocker =
  | "routing_off"
  | "before_routing_was_enabled"
  | "too_old"
  | "not_routable_status"
  | "handled_by_a_person"
  | "routing_stopped"
  | "test_lead"
  | "erased"
  | "waiting_to_retry";

export const BLOCKER_TEXT: Record<Blocker, string> = {
  routing_off: "Automatic routing is switched off",
  before_routing_was_enabled: "The lead arrived before automatic routing was switched on, so it is never routed automatically",
  too_old: "The lead is older than the age limit for automatic routing",
  not_routable_status: "The lead is not waiting to be routed (it is held, assigned, closed, or being handled)",
  handled_by_a_person: "A person marked it handled",
  routing_stopped: "A person took it back for a reason that needs a person to decide",
  test_lead: "It is a test lead",
  erased: "Its personal data was erased",
  waiting_to_retry: "It found nobody recently and is waiting for the next look",
};

export interface Explanation {
  leadId: string;
  reference: string;
  status: string;
  routingEnabled: boolean;
  /** Reasons the router would leave this lead alone right now. Empty = it would take it. */
  blockers: Blocker[];
  /** The decision as if the router took it NOW. Absent when the lead cannot be decided (erased, no postcode). */
  analysis: { detail: RunDetail; ranking: string[]; chosenClientId: string | undefined } | undefined;
  rules: CompiledRules["snapshot"];
}

// ------------------------------------------------------------------------------------------------
// The service
// ------------------------------------------------------------------------------------------------

const isTransient = (error: unknown): boolean => {
  const code = (error as { code?: string } | null)?.code;
  return code === "40P01" || code === "40001" || code === "55P03";
};

/**
 * The database or the network failed us (a connection killed, a failover, too many connections, a timeout): nothing is wrong with
 * the LEAD, so it must not be parked. It stays `new`, and the next poll (seconds) routes it. Only a failure that would repeat for this lead
 * (a bug, a constraint nobody expected) parks it.
 */
const isInfrastructure = (error: unknown): boolean => {
  const { code = "", message = "" } = (error ?? {}) as { code?: string; message?: string };
  return (
    code.startsWith("08") || code.startsWith("53") || code.startsWith("57") || code === "55P03" || code === "40P01" || code === "40001" ||
    ["ECONNRESET", "ETIMEDOUT", "EPIPE", "ECONNREFUSED"].includes(code) ||
    /connection terminated|connection ended|timeout exceeded when trying to connect|terminating connection/i.test(message)
  );
};

export function createRoutingService(deps: RoutingServiceDeps) {
  const { db, logger } = deps;
  let cachedVertical: number | undefined;

  async function verticalId(): Promise<number> {
    if (cachedVertical !== undefined) return cachedVertical;
    const row = await db.selectFrom("verticals").select("id").where("slug", "=", deps.verticalSlug).executeTakeFirst();
    if (!row) throw new Error(`vertical "${deps.verticalSlug}" is not seeded`);
    return (cachedVertical = row.id);
  }

  const now = async (handle: Database): Promise<Date> => {
    if (deps.clock) return deps.clock(handle);
    const { rows } = await sql<{ at: Date }>`select clock_timestamp() as at`.execute(handle);
    return rows[0]!.at;
  };

  async function loadRules(handle: Database, vertical: number): Promise<CompiledRules> {
    return compileRules(await listRules(handle, vertical));
  }

  /**
   * The decision for one lead, read at one instant. Used by the real router (inside its transaction, under the routing lock) and by
   * the admin's explanation (no lock, no writes): it is the same code, so the explanation cannot disagree with what routing does.
   */
  async function analyse(handle: Database, lead: RoutableLead, rules: CompiledRules, at: Date): Promise<Analysis | { error: "unknown_postcode" | "no_postcode" }> {
    if (!lead.postcode) return { error: "no_postcode" };
    const query: CoverageQuery = { postcode: lead.postcode, verticalId: lead.verticalId, serviceTypeId: lead.serviceTypeId, saleType: "exclusive" };
    const coverage = await explainCoverage(handle, query);
    if (coverage.status === "unknown_postcode") return { error: "unknown_postcode" };

    const covered = coverage.clients.filter((client) => client.eligible);
    const notCovered = coverage.clients.filter((client) => !client.eligible).map((client) => ({ clientId: client.clientId, name: client.name, reasons: client.reasons }));
    const facts = await loadClientFacts(handle, { leadId: lead.id, clientIds: covered.map((client) => client.clientId), at, windowDays: fairnessWindowDays(rules) });
    const price = await resolvePrice(handle, { verticalId: lead.verticalId, serviceTypeId: lead.serviceTypeId, postcodeOutward: lead.postcodeOutward, urgency: lead.urgency, saleType: "exclusive" });
    const decision = decide(rules, facts, { pricePence: price?.pricePence ?? null });

    return {
      decision,
      rules,
      facts,
      detail: {
        lead: { reference: lead.reference, postcodeOutward: lead.postcodeOutward, serviceTypeId: lead.serviceTypeId, urgency: lead.urgency },
        coverage: { clients: coverage.clients.length, covered: covered.length },
        price: price ? { pence: price.pricePence, ruleId: price.ruleId } : null,
        clients: decision.verdicts.map((verdict): CandidateRecord => verdict),
        notCovered,
        at: at.toISOString(),
      },
    };
  }

  // ----------------------------------------------------------------------------------------------
  // The router
  // ----------------------------------------------------------------------------------------------

  /** One transaction: take the oldest routable lead, decide, and either hand it to a business or record why not. */
  async function routeOnce(vertical: number): Promise<RouteResult | undefined> {
    const started = performance.now();
    const requestId = randomUUID();
    // An object, not a `let`: it is assigned inside the transaction callback, which TypeScript's flow analysis cannot see from the catch below.
    const state: { claimed?: { id: string; reference: string; status: string } } = {};

    try {
      return await db.transaction().execute(async (trx): Promise<RouteResult | undefined> => {
        state.claimed = undefined;
        await setSystemContext(trx, { requestId, reason: "auto_routed" });
        await lockRouting(trx, vertical);

        const settings = await getSettings(trx, vertical);
        if (!settings.enabled) return undefined;
        const lead = await claimNextLead(trx, vertical);
        if (!lead) return undefined;
        state.claimed = { id: lead.id, reference: lead.reference, status: lead.status };

        const rules = await loadRules(trx, vertical);
        const at = await now(trx);
        const elapsed = () => performance.now() - started;
        const finish = async (outcome: RunOutcome, extra: { detail?: RunDetail; chosen?: string; price?: number | null; reason?: string }): Promise<string> =>
          insertRun(trx, {
            leadId: lead.id, outcome, rules: rules.snapshot, algorithmVersion: ROUTING_ALGORITHM_VERSION,
            candidates: extra.detail ?? { lead: { reference: lead.reference } }, chosenClientId: extra.chosen ?? null,
            pricePence: extra.price ?? null, error: extra.reason ?? null, durationMs: elapsed(),
          });

        // Things that mean this lead must NOT be given to anyone, whatever the rules say.
        const consent = await consentState(trx, lead.id);
        if (consent.withdrawn || (await deps.isSuppressed(trx, lead.id))) {
          const reason = consent.withdrawn ? "consent_withdrawn" : "suppressed";
          await setSystemContext(trx, { requestId, reason: "routing_stopped" });
          const runId = await finish("skipped", { reason });
          await transitionLead(trx, lead.id, lead.status, "invalid");
          await markAttempted(trx, lead.id);
          return { leadId: lead.id, reference: lead.reference, outcome: "skipped", reason, runId, durationMs: elapsed() };
        }

        const analysis = await analyse(trx, lead, rules, at);
        if ("error" in analysis) {
          const runId = await finish("error", { reason: analysis.error });
          await parkLead(trx, lead, requestId, runId, analysis.error);
          return { leadId: lead.id, reference: lead.reference, outcome: "error", reason: analysis.error, runId, durationMs: elapsed() };
        }
        const { detail, decision } = analysis;

        if (consent.maxRecipients === null || consent.maxRecipients < 1) {
          const runId = await finish("skipped", { detail, reason: "no_consent_to_share" });
          await parkLead(trx, lead, requestId, runId, "no_consent_to_share");
          return { leadId: lead.id, reference: lead.reference, outcome: "skipped", reason: "no_consent_to_share", runId, durationMs: elapsed() };
        }
        if (!detail.price) {
          // No pricing rule: the router never invents a price. An operator can still hand the lead over (and is asked for one).
          const runId = await finish("no_candidates", { detail, reason: "price_required" });
          await parkLead(trx, lead, requestId, runId, "price_required");
          return { leadId: lead.id, reference: lead.reference, outcome: "no_candidates", reason: "price_required", runId, durationMs: elapsed() };
        }

        // Try the ranked businesses in order. Each is locked and looked at again first: something may have changed since the facts were read.
        const query: CoverageQuery = { postcode: lead.postcode!, verticalId: lead.verticalId, serviceTypeId: lead.serviceTypeId, saleType: "exclusive" };
        let chosen: string | undefined;
        for (const clientId of decision.ranking.slice(0, ROUTING_POLICY.maxReserveAttempts)) {
          const candidate = detail.clients.find((entry) => entry.clientId === clientId)!;
          const locked = await lockClientForRouting(trx, clientId);
          let stillFine = locked?.status === "active";
          if (stillFine) {
            const coverage = await explainCoverage(trx, query, { clientId });
            stillFine = coverage.status === "ok" && coverage.clients[0]?.eligible === true;
          }
          if (stillFine) {
            const [fresh] = await loadClientFacts(trx, { leadId: lead.id, clientIds: [clientId], at, windowDays: fairnessWindowDays(rules) });
            stillFine = fresh !== undefined && evaluateClient(rules, fresh, { pricePence: detail.price.pence }).eligible;
          }
          if (stillFine) {
            candidate.result = "chosen";
            chosen = clientId;
            break;
          }
          candidate.result = "changed_while_routing";
        }

        if (!chosen) {
          const runId = await finish("no_candidates", { detail, reason: "no_eligible_client" });
          await parkLead(trx, lead, requestId, runId, "no_eligible_client");
          return { leadId: lead.id, reference: lead.reference, outcome: "no_candidates", reason: "no_eligible_client", runId, durationMs: elapsed() };
        }

        // Assign. History triggers read the context set above: the actor is the system, the reason "auto_routed".
        const runId = await finish("assigned", { detail, chosen, price: detail.price.pence });
        await commitExclusive(trx, lead.id);
        await insertRoutedAssignment(trx, { leadId: lead.id, clientId: chosen, routingRunId: runId, pricePence: detail.price.pence, pricingRuleId: detail.price.ruleId });
        if (!(await transitionLead(trx, lead.id, lead.status, "assigned"))) throw new Error("lead changed status while locked");
        await markAttempted(trx, lead.id);
        await recordLeadEvent(trx, { leadId: lead.id, type: LEAD_EVENT.routed, requestId, payload: { run_id: runId, client_id: chosen } });
        return { leadId: lead.id, reference: lead.reference, outcome: "assigned", clientId: chosen, runId, durationMs: elapsed() };
      });
    } catch (error) {
      if (state.claimed && !isInfrastructure(error)) {
        // Never let one bad lead be retried in a hot loop: record the failure and park it (retried in a few minutes, and visible to a person).
        const parked = state.claimed;
        const durationMs = performance.now() - started;
        logger.error({ err: error, leadId: parked.id, check: "routing" }, "routing failed for a lead; it is parked for a person to look at");
        await recordFailure(parked, error, durationMs).catch((secondary: unknown) => logger.error({ err: secondary, leadId: parked.id }, "could not record the routing failure"));
        return { leadId: parked.id, reference: parked.reference, outcome: "error", reason: "exception", durationMs };
      }
      throw error;
    }
  }

  /** Records that nobody could take the lead and moves it to `unroutable` (a person sees it; it is looked at again later). Inside the routing transaction. */
  async function parkLead(trx: Database, lead: RoutableLead, requestId: string, runId: string, reason: string): Promise<void> {
    await markAttempted(trx, lead.id);
    if (lead.status === "new") {
      await setSystemContext(trx, { requestId, reason: "routing_no_candidates" });
      await transitionLead(trx, lead.id, "new", "unroutable");
    }
    if (!(await hasUnroutableEvent(trx, lead.id))) {
      await recordLeadEvent(trx, { leadId: lead.id, type: LEAD_EVENT.unroutable, requestId, payload: { run_id: runId, reason } });
    }
  }

  async function recordFailure(lead: { id: string; reference: string; status: string }, error: unknown, durationMs: number): Promise<void> {
    const requestId = randomUUID();
    const vertical = await verticalId();
    await db.transaction().execute(async (trx) => {
      await setSystemContext(trx, { requestId, reason: "routing_no_candidates" });
      const rules = await listRules(trx, vertical).then((rows) => rows.filter((row) => row.active).map((row) => ({ type: row.type, version: row.version }))).catch(() => []);
      const code = error instanceof RulesConfigError ? "rules_invalid" : "exception";
      const runId = await insertRun(trx, {
        leadId: lead.id, outcome: "error", rules, algorithmVersion: ROUTING_ALGORITHM_VERSION, candidates: { lead: { reference: lead.reference } },
        chosenClientId: null, pricePence: null, error: code, durationMs,
      });
      await markAttempted(trx, lead.id);
      if (lead.status === "new") await transitionLead(trx, lead.id, "new", "unroutable");
      if (!(await hasUnroutableEvent(trx, lead.id))) await recordLeadEvent(trx, { leadId: lead.id, type: LEAD_EVENT.unroutable, requestId, payload: { run_id: runId, reason: code } });
    });
  }

  async function routeNext(): Promise<RouteResult | undefined> {
    const vertical = await verticalId();
    // Cheap and lock-free: most polls find nothing, and nothing should queue behind the routing lock to learn that.
    if (!(await hasRoutableLead(db, vertical))) return undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await routeOnce(vertical);
      } catch (error) {
        if (!isTransient(error)) throw error;
        lastError = error;
        logger.warn({ err: error, attempt, check: "routing" }, "routing hit a lock conflict; retrying");
      }
    }
    throw lastError;
  }

  // ----------------------------------------------------------------------------------------------
  // Public surface
  // ----------------------------------------------------------------------------------------------

  /** Is THIS lead one the router would claim right now? (Used to tell "waiting for its next look" from "would be taken".) */
  async function hasRoutableLeadFor(leadId: string, vertical: number): Promise<boolean> {
    const { rows } = await sql<{ found: boolean }>`
      select exists (
        select 1 from leads l join routing_settings s on s.vertical_id = l.vertical_id
         where l.id = ${leadId} and l.vertical_id = ${vertical}
           and (l.status = 'new' or coalesce(l.routing_attempted_at, l.status_changed_at) < greatest(now() - make_interval(mins => ${ROUTING_POLICY.unroutableRetryMinutes}), s.poked_at))) as found`.execute(db);
    return rows[0]?.found ?? false;
  }

  const requireOwner = (operator: Operator): RoutingResult | undefined => (operator.role === "owner" ? undefined : { ok: false, code: "forbidden" });

  return {
    routeNext,

    /** Routes until nothing is left to do (or `max` leads, so a burst cannot starve the worker's other jobs). */
    async drain(options: { max?: number } = {}): Promise<{ routed: number; assigned: number; unroutable: number; skipped: number; errors: number }> {
      const max = options.max ?? 50;
      const tally = { routed: 0, assigned: 0, unroutable: 0, skipped: 0, errors: 0 };
      while (tally.routed < max) {
        const result = await routeNext();
        if (!result) break;
        tally.routed += 1;
        if (result.outcome === "assigned") tally.assigned += 1;
        else if (result.outcome === "no_candidates") tally.unroutable += 1;
        else if (result.outcome === "skipped") tally.skipped += 1;
        else tally.errors += 1;
        logger.info({ leadId: result.leadId, outcome: result.outcome, clientId: result.clientId, reason: result.reason, durationMs: Math.round(result.durationMs), runId: result.runId }, "lead routed");
        if (result.outcome === "error") break; // never spin on a failing lead: it is parked, and the next poll looks again
      }
      return tally;
    },

    /**
     * "Who would get this lead if the router looked at it now?" Read-only, no lock, and the same decision code as the real router.
     * Also says why the router would leave the lead alone, if it would.
     */
    async explain(leadId: string): Promise<Explanation | undefined> {
      const vertical = await verticalId();
      const lead = await readLead(db, leadId);
      if (!lead) return undefined;
      const settings = await getSettings(db, lead.verticalId);
      const rules = await loadRules(db, lead.verticalId);

      const blockers: Blocker[] = [];
      if (!settings.enabled) blockers.push("routing_off");
      if (settings.enabled && settings.enabledAt && lead.createdAt < settings.enabledAt) blockers.push("before_routing_was_enabled");
      if ((Date.now() - lead.createdAt.getTime()) / 3_600_000 > settings.maxLeadAgeHours) blockers.push("too_old");
      if (lead.status !== "new" && lead.status !== "unroutable") blockers.push("not_routable_status");
      if (lead.handled) blockers.push("handled_by_a_person");
      if (lead.routingStopped) blockers.push("routing_stopped");
      if (lead.erased) blockers.push("erased");
      if (lead.status === "unroutable" && blockers.length === 0) {
        const due = await hasRoutableLeadFor(lead.id, vertical);
        if (!due) blockers.push("waiting_to_retry");
      }

      let analysis: Explanation["analysis"];
      if (!lead.erased) {
        const result = await analyse(db, lead, rules, await now(db));
        if (!("error" in result)) analysis = { detail: result.detail, ranking: result.decision.ranking, chosenClientId: result.decision.ranking[0] };
      }
      return { leadId: lead.id, reference: lead.reference, status: lead.status, routingEnabled: settings.enabled, blockers, analysis, rules: rules.snapshot };
    },

    runsForLead: (leadId: string) => runsForLead(db, leadId),

    async overview(): Promise<{ settings: RoutingSettings; rules: Array<RuleRow & { title: string; summary: string }>; stats: RoutingStats; runs: StoredRun[] }> {
      const vertical = await verticalId();
      const [settings, rules, stats, runs] = await Promise.all([getSettings(db, vertical), listRules(db, vertical), routingStats(db, 24), recentRuns(db, 40)]);
      return { settings, rules: rules.map((rule) => ({ ...rule, title: RULE_INFO[rule.type].title, summary: RULE_INFO[rule.type].summary })), stats, runs };
    },

    /** Owners only: switching routing on decides who gets leads without a person in the loop. */
    async setEnabled(input: { operator: Operator; enabled: boolean; requestId: string }): Promise<RoutingResult> {
      const denied = requireOwner(input.operator);
      if (denied) return denied;
      const vertical = await verticalId();
      await db.transaction().execute(async (trx) => {
        const before = await getSettings(trx, vertical);
        await saveSettings(trx, { verticalId: vertical, enabled: input.enabled, operatorId: input.operator.id });
        await writeAudit(trx, {
          actorId: input.operator.id, action: input.enabled ? "routing.enabled" : "routing.disabled", entityType: "routing", entityId: String(vertical),
          before: { enabled: before.enabled }, after: { enabled: input.enabled }, requestId: input.requestId,
        });
      });
      logger.warn({ operatorId: input.operator.id, enabled: input.enabled, check: "routing" }, input.enabled ? "automatic routing switched ON" : "automatic routing switched OFF");
      return { ok: true };
    },

    async setMaxLeadAge(input: { operator: Operator; hours: number; requestId: string }): Promise<RoutingResult> {
      const denied = requireOwner(input.operator);
      if (denied) return denied;
      if (!Number.isInteger(input.hours) || input.hours < 1 || input.hours > 168) return { ok: false, code: "invalid_age", message: "Enter a whole number of hours from 1 to 168." };
      const vertical = await verticalId();
      await db.transaction().execute(async (trx) => {
        const before = await getSettings(trx, vertical);
        await saveSettings(trx, { verticalId: vertical, enabled: before.enabled, maxLeadAgeHours: input.hours, operatorId: input.operator.id });
        await writeAudit(trx, { actorId: input.operator.id, action: "routing.max_age_changed", entityType: "routing", entityId: String(vertical), before: { hours: before.maxLeadAgeHours }, after: { hours: input.hours }, requestId: input.requestId });
      });
      return { ok: true };
    },

    /** Owners only. `config` is the raw form value; it is validated against the rule's own schema. A stale `expectedVersion` is refused. */
    async updateRule(input: { operator: Operator; ruleId: string; expectedVersion: number; active: boolean; config: unknown; requestId: string }): Promise<RoutingResult> {
      const denied = requireOwner(input.operator);
      if (denied) return denied;
      const vertical = await verticalId();
      return db.transaction().execute(async (trx): Promise<RoutingResult> => {
        const rule = await getRule(trx, vertical, input.ruleId);
        if (!rule) return { ok: false, code: "not_found" };
        const parsed = parseRuleConfig(rule.type, input.config);
        if (!parsed.ok) return { ok: false, code: "invalid_config", message: parsed.message };
        if (!(await updateRule(trx, { ruleId: rule.id, expectedVersion: input.expectedVersion, active: input.active, config: parsed.value, operatorId: input.operator.id }))) return { ok: false, code: "stale" };
        await writeAudit(trx, {
          actorId: input.operator.id, action: "routing.rule_changed", entityType: "routing_rule", entityId: rule.id,
          before: { type: rule.type, active: rule.active, config: rule.config, version: rule.version },
          after: { type: rule.type, active: input.active, config: parsed.value, version: rule.version + 1 }, requestId: input.requestId,
        });
        return { ok: true };
      });
    },

    /** Owners only. Only rankers have an order that matters (they are tie-breakers applied in sequence). */
    async moveRule(input: { operator: Operator; ruleId: string; direction: "up" | "down"; requestId: string }): Promise<RoutingResult> {
      const denied = requireOwner(input.operator);
      if (denied) return denied;
      const vertical = await verticalId();
      return db.transaction().execute(async (trx): Promise<RoutingResult> => {
        const rules = await listRules(trx, vertical);
        const index = rules.findIndex((rule) => rule.id === input.ruleId);
        const rule = rules[index];
        if (!rule) return { ok: false, code: "not_found" };
        if (RULE_KIND[rule.type] !== "ranker") return { ok: false, code: "cannot_move", message: "Only the ranking rules have an order." };
        const siblings = rules.filter((candidate) => candidate.kind === "ranker");
        const at = siblings.findIndex((candidate) => candidate.id === rule.id);
        const other = siblings[input.direction === "up" ? at - 1 : at + 1];
        if (!other) return { ok: false, code: "cannot_move", message: "It is already at the end." };
        await swapPositions(trx, rule, other, input.operator.id);
        await writeAudit(trx, { actorId: input.operator.id, action: "routing.rule_moved", entityType: "routing_rule", entityId: rule.id, before: { type: rule.type, position: rule.position }, after: { type: rule.type, position: other.position, swapped_with: other.type }, requestId: input.requestId });
        return { ok: true };
      });
    },
  };
}

export type RoutingService = ReturnType<typeof createRoutingService>;
