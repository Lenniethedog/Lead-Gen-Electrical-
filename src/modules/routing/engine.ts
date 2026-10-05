import type { CompiledRules } from "./rules";

/**
 * The decision, as pure functions: facts in, verdicts and a ranking out. No database, no clock, no randomness. The real router and the
 * admin's "who would get this lead?" both call `decide`, so an explanation can never disagree with what routing actually does
 * (a test asserts the parity on real data). The ranking is a total order, so the same facts always give the same answer.
 */

export interface WorkingWindow {
  /** 0 = Sunday, in the business's own time zone. */
  weekday: number;
  opensMinutes: number;
  closesMinutes: number;
}

/** Everything the decision needs to know about one business, read once, at one instant. */
export interface ClientFacts {
  clientId: string;
  name: string;
  priority: number;
  /** 0 = manual only: never routed automatically. */
  weight: number;
  dailyCap: number | null;
  monthlyCap: number | null;
  /** Leads it currently holds that were assigned today / this month / in the fairness window (its own time zone for the first two). */
  assignedToday: number;
  assignedThisMonth: number;
  assignedInWindow: number;
  lastAssignedAt: Date | null;
  /** No windows = no restriction. */
  hours: WorkingWindow[];
  /** The moment of the decision, as the business's own clock shows it. */
  localWeekday: number;
  localMinutes: number;
  /** The end of a pause covering the moment, if there is one. */
  pausedUntil: Date | null;
  /** The business has held THIS lead before (and gave it back): it does not get it again. */
  previouslyHeld: boolean;
  /** The most leads it wants to hold unanswered at once (null = no limit), and how many it holds unanswered now (reserved or notified). */
  maxOpenLeads: number | null;
  openUnanswered: number;
}

export type ExclusionCode = "manual_only" | "previously_held" | "paused" | "outside_working_hours" | "daily_cap_reached" | "monthly_cap_reached" | "max_open_leads_reached";

export const EXCLUSION_TEXT: Record<ExclusionCode, string> = {
  manual_only: "Set to manual only (weight 0): never routed automatically",
  previously_held: "Already had this lead and gave it back",
  paused: "Paused",
  outside_working_hours: "Outside its working hours",
  daily_cap_reached: "Reached its daily lead cap",
  monthly_cap_reached: "Reached its monthly lead cap",
  max_open_leads_reached: "Already holds as many unanswered leads as it asked for",
};

export interface ClientVerdict {
  clientId: string;
  name: string;
  eligible: boolean;
  excludedBy: ExclusionCode[];
  /** Numbers that explain the verdict (cap and count, the pause end, the local time). Ids and counts only. */
  detail: Record<string, string | number | boolean | null>;
}

export interface RankingKeys {
  priority: number;
  /** Leads in the window divided by weight, rounded for display only (the comparison itself is exact). */
  fairness: number;
  lastAssignedAt: string | null;
}

export interface RankedVerdict extends ClientVerdict {
  /** 1 = chosen first. Null for a business that was excluded. */
  rank: number | null;
  keys: RankingKeys | null;
}

export interface Decision {
  verdicts: RankedVerdict[];
  /** Eligible businesses, best first. */
  ranking: string[];
}

/** Open if there are no hours at all, or a window covers the local time and ends more than `graceMinutes` from now. */
export function isOpen(hours: readonly WorkingWindow[], weekday: number, minutes: number, graceMinutes: number): boolean {
  if (hours.length === 0) return true;
  return hours.some((window) => window.weekday === weekday && minutes >= window.opensMinutes && minutes < window.closesMinutes - graceMinutes);
}

export function evaluateClient(rules: CompiledRules, facts: ClientFacts): ClientVerdict {
  const excludedBy: ExclusionCode[] = [];
  const detail: ClientVerdict["detail"] = {};

  if (facts.weight === 0) excludedBy.push("manual_only");
  if (facts.previouslyHeld) excludedBy.push("previously_held");
  if (facts.pausedUntil) {
    excludedBy.push("paused");
    detail.pausedUntil = facts.pausedUntil.toISOString();
  }
  if (rules.workingHours && !isOpen(facts.hours, facts.localWeekday, facts.localMinutes, rules.workingHours.graceMinutes)) {
    excludedBy.push("outside_working_hours");
    detail.localWeekday = facts.localWeekday;
    detail.localMinutes = facts.localMinutes;
  }
  if (rules.dailyCap && facts.dailyCap !== null && facts.assignedToday >= facts.dailyCap) {
    excludedBy.push("daily_cap_reached");
    detail.dailyCap = facts.dailyCap;
    detail.assignedToday = facts.assignedToday;
  }
  if (rules.monthlyCap && facts.monthlyCap !== null && facts.assignedThisMonth >= facts.monthlyCap) {
    excludedBy.push("monthly_cap_reached");
    detail.monthlyCap = facts.monthlyCap;
    detail.assignedThisMonth = facts.assignedThisMonth;
  }
  // Not a rule: a business that asked to hold at most N unanswered leads is never given an (N+1)th, whatever the rules say.
  if (facts.maxOpenLeads !== null && facts.openUnanswered >= facts.maxOpenLeads) {
    excludedBy.push("max_open_leads_reached");
    detail.maxOpenLeads = facts.maxOpenLeads;
    detail.openUnanswered = facts.openUnanswered;
  }
  return { clientId: facts.clientId, name: facts.name, eligible: excludedBy.length === 0, excludedBy, detail };
}

type Ranker = CompiledRules["rankers"][number];

/** Negative when `a` should go first. Integer arithmetic only, so there is no rounding to disagree about. */
function compareBy(ranker: Ranker, a: ClientFacts, b: ClientFacts): number {
  switch (ranker.type) {
    case "priority":
      return a.priority - b.priority;
    case "weighted_fairness":
      // a.count / a.weight  <  b.count / b.weight   <=>   a.count * b.weight < b.count * a.weight  (weights are > 0 here: 0 was excluded)
      return a.assignedInWindow * b.weight - b.assignedInWindow * a.weight;
    case "least_recently_assigned": {
      if (a.lastAssignedAt === null && b.lastAssignedAt === null) return 0;
      if (a.lastAssignedAt === null) return -1; // never had one: has waited longest
      if (b.lastAssignedAt === null) return 1;
      return a.lastAssignedAt.getTime() - b.lastAssignedAt.getTime();
    }
  }
}

/** A total order: the rankers in position order, then the business id, so equal facts never depend on the order they were read in. */
export function rank(rules: CompiledRules, eligible: readonly ClientFacts[]): ClientFacts[] {
  return [...eligible].sort((a, b) => {
    for (const ranker of rules.rankers) {
      const difference = compareBy(ranker, a, b);
      if (difference !== 0) return difference;
    }
    return a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0;
  });
}

const keysOf = (facts: ClientFacts): RankingKeys => ({
  priority: facts.priority,
  fairness: facts.weight > 0 ? Math.round((facts.assignedInWindow / facts.weight) * 10_000) / 10_000 : 0,
  lastAssignedAt: facts.lastAssignedAt ? facts.lastAssignedAt.toISOString() : null,
});

export function decide(rules: CompiledRules, clients: readonly ClientFacts[]): Decision {
  const byId = new Map(clients.map((facts) => [facts.clientId, facts]));
  const verdicts = clients.map((facts) => evaluateClient(rules, facts));
  const eligibleIds = new Set(verdicts.filter((verdict) => verdict.eligible).map((verdict) => verdict.clientId));
  const ordered = rank(rules, clients.filter((facts) => eligibleIds.has(facts.clientId)));
  const position = new Map(ordered.map((facts, index) => [facts.clientId, index + 1]));
  return {
    verdicts: verdicts.map((verdict): RankedVerdict => ({
      ...verdict,
      rank: position.get(verdict.clientId) ?? null,
      keys: verdict.eligible ? keysOf(byId.get(verdict.clientId)!) : null,
    })),
    ranking: ordered.map((facts) => facts.clientId),
  };
}
