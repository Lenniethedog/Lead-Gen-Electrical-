import * as z from "zod";

/**
 * Routing rules: ordered, editable, validated in code. New KINDS of rule need code (a new type below); new parameters, order and
 * on/off do not (an owner edits them in the admin, no deploy). Each type exists once per vertical.
 *
 *   filter   a business is skipped unless it passes (working hours)
 *   limiter  a business is skipped once it has had enough (daily and monthly caps; the cap itself is the business's own setting)
 *   ranker   among the businesses left, successive tie-breakers in `position` order (priority, fairness, least recently given one)
 *
 * What is NOT a rule, on purpose: the things that must always hold (the business is active and covers the postcode, a pause is a
 * pause, "manual only" means manual only, a business that already had this lead and gave it back does not get it again). A switch
 * that could turn those off would be a way to break a promise to a client or a consumer.
 */
export const RULE_TYPES = ["working_hours", "daily_cap", "monthly_cap", "priority", "weighted_fairness", "least_recently_assigned"] as const;
export type RuleType = (typeof RULE_TYPES)[number];
export type RuleKind = "filter" | "limiter" | "ranker";

export const RULE_KIND: Record<RuleType, RuleKind> = {
  working_hours: "filter",
  daily_cap: "limiter",
  monthly_cap: "limiter",
  priority: "ranker",
  weighted_fairness: "ranker",
  least_recently_assigned: "ranker",
};

const noConfig = z.object({}).strict();
export const RULE_CONFIG_SCHEMAS = {
  working_hours: z.object({ graceMinutes: z.number().int().min(0).max(120) }).strict(),
  daily_cap: noConfig,
  monthly_cap: noConfig,
  priority: noConfig,
  weighted_fairness: z.object({ windowDays: z.number().int().min(1).max(90) }).strict(),
  least_recently_assigned: noConfig,
} as const;

export interface RuleConfigs {
  working_hours: { graceMinutes: number };
  daily_cap: Record<string, never>;
  monthly_cap: Record<string, never>;
  priority: Record<string, never>;
  weighted_fairness: { windowDays: number };
  least_recently_assigned: Record<string, never>;
}

export const RULE_INFO: Record<RuleType, { title: string; summary: string; params?: Array<{ key: string; label: string; hint: string; min: number; max: number }> }> = {
  working_hours: {
    title: "Working hours",
    summary: "Only offer a lead to a business during the hours it set. A business with no hours set is available at any time.",
    params: [{ key: "graceMinutes", label: "Stop this many minutes before closing", hint: "So a lead is not sent at 4:59 pm to someone who finishes at 5.", min: 0, max: 120 }],
  },
  daily_cap: { title: "Daily lead cap", summary: "Stop offering leads to a business that has had its own daily limit today (counted in its own time zone). Leads you take back do not count." },
  monthly_cap: { title: "Monthly lead cap", summary: "The same, for the calendar month." },
  priority: { title: "Priority", summary: "Lower priority numbers go first. Businesses with the same priority are decided by the next rule." },
  weighted_fairness: {
    title: "Fair share",
    summary: "Among equals, the business that has had the fewest leads for its weight goes first (leads received in the window, divided by its weight).",
    params: [{ key: "windowDays", label: "Count leads from the last (days)", hint: "A shorter window evens things out faster.", min: 1, max: 90 }],
  },
  least_recently_assigned: { title: "Longest wait", summary: "Among equals, the business that has waited longest since its last lead goes first." },
};

/** The rules a new vertical starts with. Seeded once; after that they are the owner's to edit. */
export const DEFAULT_RULES: ReadonlyArray<{ type: RuleType; position: number; config: Record<string, unknown> }> = [
  { type: "working_hours", position: 1, config: { graceMinutes: 15 } },
  { type: "daily_cap", position: 1, config: {} },
  { type: "monthly_cap", position: 2, config: {} },
  { type: "priority", position: 1, config: {} },
  { type: "weighted_fairness", position: 2, config: { windowDays: 30 } },
  { type: "least_recently_assigned", position: 3, config: {} },
];

export interface RuleRow {
  id: string;
  type: RuleType;
  kind: RuleKind;
  position: number;
  config: Record<string, unknown>;
  active: boolean;
  version: number;
}

/** What is stored on every run, so "which rules were in force" survives later edits. */
export interface RuleSnapshot {
  type: RuleType;
  kind: RuleKind;
  position: number;
  version: number;
  config: Record<string, unknown>;
}

export type ParsedConfig = { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

export function parseRuleConfig(type: RuleType, raw: unknown): ParsedConfig {
  const result = RULE_CONFIG_SCHEMAS[type].safeParse(raw);
  if (result.success) return { ok: true, value: result.data as Record<string, unknown> };
  const info = RULE_INFO[type].params?.[0];
  return { ok: false, message: info ? `${info.label}: enter a whole number from ${info.min} to ${info.max}.` : "This rule has no settings." };
}

export class RulesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RulesConfigError";
  }
}

/** The rules the engine runs, from the active rows. A stored config that no longer validates FAILS CLOSED: nothing is routed on rules nobody understands. */
export interface CompiledRules {
  workingHours: { graceMinutes: number } | undefined;
  dailyCap: boolean;
  monthlyCap: boolean;
  /** In position order. */
  rankers: Array<{ type: "priority" | "weighted_fairness" | "least_recently_assigned"; windowDays?: number }>;
  snapshot: RuleSnapshot[];
}

export function compileRules(rows: readonly RuleRow[]): CompiledRules {
  const active = rows.filter((row) => row.active);
  const compiled: CompiledRules = { workingHours: undefined, dailyCap: false, monthlyCap: false, rankers: [], snapshot: [] };
  const kindOrder: Record<RuleKind, number> = { filter: 0, limiter: 1, ranker: 2 };
  for (const row of [...active].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind] || a.position - b.position || a.type.localeCompare(b.type))) {
    const parsed = parseRuleConfig(row.type, row.config);
    if (!parsed.ok) throw new RulesConfigError(`routing rule "${row.type}" has invalid settings: ${parsed.message}`);
    compiled.snapshot.push({ type: row.type, kind: row.kind, position: row.position, version: row.version, config: parsed.value });
    switch (row.type) {
      case "working_hours":
        compiled.workingHours = { graceMinutes: (parsed.value as RuleConfigs["working_hours"]).graceMinutes };
        break;
      case "daily_cap":
        compiled.dailyCap = true;
        break;
      case "monthly_cap":
        compiled.monthlyCap = true;
        break;
      case "priority":
      case "least_recently_assigned":
        compiled.rankers.push({ type: row.type });
        break;
      case "weighted_fairness":
        compiled.rankers.push({ type: row.type, windowDays: (parsed.value as RuleConfigs["weighted_fairness"]).windowDays });
        break;
    }
  }
  return compiled;
}

/** Days for the fairness window: the loader needs it to count, whether or not the rule is on (the explanation can still show it). */
export const fairnessWindowDays = (rules: CompiledRules): number => rules.rankers.find((ranker) => ranker.type === "weighted_fairness")?.windowDays ?? 30;
