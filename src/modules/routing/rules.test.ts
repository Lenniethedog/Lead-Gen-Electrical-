import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, RULE_KIND, RULE_TYPES, RulesConfigError, compileRules, fairnessWindowDays, parseRuleConfig, type RuleRow } from "./rules";

const row = (type: RuleRow["type"], overrides: Partial<RuleRow> = {}): RuleRow => ({
  id: `id-${type}`, type, kind: RULE_KIND[type], position: 1, config: {}, active: true, version: 1, ...overrides,
});

describe("rule configuration", () => {
  it("knows the kind of every type, and the defaults cover every type exactly once", () => {
    expect(DEFAULT_RULES.map((rule) => rule.type).sort()).toEqual([...RULE_TYPES].sort());
  });

  it("validates settings strictly: whole numbers in range, nothing extra", () => {
    expect(parseRuleConfig("working_hours", { graceMinutes: 15 })).toEqual({ ok: true, value: { graceMinutes: 15 } });
    expect(parseRuleConfig("working_hours", { graceMinutes: 121 }).ok).toBe(false);
    expect(parseRuleConfig("working_hours", { graceMinutes: -1 }).ok).toBe(false);
    expect(parseRuleConfig("working_hours", { graceMinutes: 1.5 }).ok).toBe(false);
    expect(parseRuleConfig("working_hours", { graceMinutes: "15" }).ok).toBe(false);
    expect(parseRuleConfig("working_hours", {}).ok).toBe(false);
    expect(parseRuleConfig("weighted_fairness", { windowDays: 30, extra: true }).ok).toBe(false);
    expect(parseRuleConfig("weighted_fairness", { windowDays: 0 }).ok).toBe(false);
    expect(parseRuleConfig("weighted_fairness", { windowDays: 91 }).ok).toBe(false);
    expect(parseRuleConfig("daily_cap", {})).toEqual({ ok: true, value: {} });
    expect(parseRuleConfig("daily_cap", { anything: 1 }).ok).toBe(false);
  });

  it("compiles only the active rules, rankers in position order", () => {
    const compiled = compileRules([
      row("least_recently_assigned", { position: 3 }),
      row("priority", { position: 1 }),
      row("weighted_fairness", { position: 2, config: { windowDays: 14 } }),
      row("daily_cap"),
      row("monthly_cap", { active: false }),
      row("working_hours", { active: false, config: { graceMinutes: 15 } }),
    ]);
    expect(compiled.rankers.map((ranker) => ranker.type)).toEqual(["priority", "weighted_fairness", "least_recently_assigned"]);
    expect(compiled.dailyCap).toBe(true);
    expect(compiled.monthlyCap).toBe(false);
    expect(compiled.workingHours).toBeUndefined();
    expect(fairnessWindowDays(compiled)).toBe(14);
    // The snapshot is what a run stores: only what was in force, with its version.
    expect(compiled.snapshot.map((rule) => rule.type)).toEqual(["daily_cap", "priority", "weighted_fairness", "least_recently_assigned"]);
  });

  it("fails CLOSED on a stored configuration that no longer validates, instead of routing on rules nobody understands", () => {
    expect(() => compileRules([row("working_hours", { config: { graceMinutes: 9999 } })])).toThrow(RulesConfigError);
    expect(() => compileRules([row("weighted_fairness", { config: {} })])).toThrow(RulesConfigError);
  });

  it("an inactive rule with a broken configuration does not matter (it is not in force)", () => {
    expect(() => compileRules([row("working_hours", { active: false, config: { graceMinutes: 9999 } })])).not.toThrow();
  });
});
