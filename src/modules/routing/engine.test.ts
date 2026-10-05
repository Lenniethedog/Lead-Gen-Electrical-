import { describe, expect, it } from "vitest";
import { compileRules, DEFAULT_RULES, RULE_KIND, type CompiledRules, type RuleRow } from "./rules";
import { decide, evaluateClient, isOpen, rank, type ClientFacts, type WorkingWindow } from "./engine";

const ALL_ON: CompiledRules = compileRules(
  DEFAULT_RULES.map((rule, index): RuleRow => ({ id: String(index), type: rule.type, kind: RULE_KIND[rule.type], position: rule.position, config: rule.config, active: true, version: 1 })),
);
const withRules = (overrides: Partial<CompiledRules>): CompiledRules => ({ ...ALL_ON, ...overrides });

const MONDAY_NOON = { localWeekday: 1, localMinutes: 12 * 60 };
const facts = (id: string, overrides: Partial<ClientFacts> = {}): ClientFacts => ({
  clientId: id, name: `Client ${id}`, priority: 100, weight: 1, dailyCap: null, monthlyCap: null,
  assignedToday: 0, assignedThisMonth: 0, assignedInWindow: 0, lastAssignedAt: null, hours: [], pausedUntil: null, previouslyHeld: false,
  ...MONDAY_NOON, ...overrides,
});
const weekdayHours = (opens: number, closes: number): WorkingWindow[] => [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opensMinutes: opens, closesMinutes: closes }));

describe("isOpen", () => {
  it("is open at any time when there are no hours at all", () => expect(isOpen([], 3, 3 * 60, 15)).toBe(true));
  it("is open inside a window, closed before it and from the closing time", () => {
    const hours = weekdayHours(8 * 60, 17 * 60);
    expect(isOpen(hours, 1, 8 * 60, 0)).toBe(true);
    expect(isOpen(hours, 1, 8 * 60 - 1, 0)).toBe(false);
    expect(isOpen(hours, 1, 17 * 60 - 1, 0)).toBe(true);
    expect(isOpen(hours, 1, 17 * 60, 0)).toBe(false);
  });
  it("stops offering leads `grace` minutes before closing", () => {
    const hours = weekdayHours(8 * 60, 17 * 60);
    expect(isOpen(hours, 1, 16 * 60 + 44, 15)).toBe(true);
    expect(isOpen(hours, 1, 16 * 60 + 45, 15)).toBe(false);
  });
  it("is closed on a day with no window (the hours exist, so the restriction applies)", () => {
    expect(isOpen(weekdayHours(8 * 60, 17 * 60), 0, 12 * 60, 0)).toBe(false);
    expect(isOpen(weekdayHours(8 * 60, 17 * 60), 6, 12 * 60, 0)).toBe(false);
  });
  it("allows two windows in a day (lunch break)", () => {
    const hours: WorkingWindow[] = [{ weekday: 1, opensMinutes: 8 * 60, closesMinutes: 12 * 60 }, { weekday: 1, opensMinutes: 13 * 60, closesMinutes: 17 * 60 }];
    expect(isOpen(hours, 1, 12 * 60 + 30, 0)).toBe(false);
    expect(isOpen(hours, 1, 14 * 60, 0)).toBe(true);
  });
  it("a grace longer than the window means it is never open (no negative-length window surprises)", () => {
    expect(isOpen([{ weekday: 1, opensMinutes: 600, closesMinutes: 610 }], 1, 605, 15)).toBe(false);
  });
});

describe("evaluateClient", () => {
  it("passes a business with nothing against it", () => {
    expect(evaluateClient(ALL_ON, facts("a"))).toMatchObject({ eligible: true, excludedBy: [] });
  });

  it("names every reason, not just the first", () => {
    const verdict = evaluateClient(ALL_ON, facts("a", { weight: 0, previouslyHeld: true, pausedUntil: new Date("2026-10-06T00:00:00Z"), hours: weekdayHours(13 * 60, 17 * 60), dailyCap: 2, assignedToday: 2, monthlyCap: 10, assignedThisMonth: 10 }));
    expect(verdict.eligible).toBe(false);
    expect(verdict.excludedBy).toEqual(["manual_only", "previously_held", "paused", "outside_working_hours", "daily_cap_reached", "monthly_cap_reached"]);
    expect(verdict.detail).toMatchObject({ dailyCap: 2, assignedToday: 2, monthlyCap: 10, assignedThisMonth: 10, pausedUntil: "2026-10-06T00:00:00.000Z" });
  });

  it("applies a cap only once the count REACHES it, and never when the business set none", () => {
    expect(evaluateClient(ALL_ON, facts("a", { dailyCap: 3, assignedToday: 2 })).eligible).toBe(true);
    expect(evaluateClient(ALL_ON, facts("a", { dailyCap: 3, assignedToday: 3 })).excludedBy).toEqual(["daily_cap_reached"]);
    expect(evaluateClient(ALL_ON, facts("a", { dailyCap: null, assignedToday: 9999 })).eligible).toBe(true);
  });

  it("ignores a limiter or filter that is switched off, but never the always-on conditions", () => {
    const loose = withRules({ dailyCap: false, monthlyCap: false, workingHours: undefined });
    const busy = facts("a", { dailyCap: 1, assignedToday: 5, monthlyCap: 1, assignedThisMonth: 5, hours: weekdayHours(13 * 60, 17 * 60) });
    expect(evaluateClient(loose, busy).eligible).toBe(true);
    expect(evaluateClient(loose, { ...busy, pausedUntil: new Date(), previouslyHeld: true, weight: 0 }).excludedBy).toEqual(["manual_only", "previously_held", "paused"]);
  });
});

describe("ranking", () => {
  const order = (rules: CompiledRules, ...clients: ClientFacts[]) => rank(rules, clients).map((client) => client.clientId);

  it("goes by priority first (lower number wins)", () => {
    expect(order(ALL_ON, facts("a", { priority: 100 }), facts("b", { priority: 10 }), facts("c", { priority: 50 }))).toEqual(["b", "c", "a"]);
  });

  it("then by leads received per unit of weight, compared exactly", () => {
    // a: 2/2 = 1, b: 1/1 = 1 (a tie, exactly), c: 3/1 = 3, d: 1/4 = 0.25
    const result = order(withRules({ rankers: [{ type: "weighted_fairness", windowDays: 30 }] }), facts("a", { assignedInWindow: 2, weight: 2 }), facts("b", { assignedInWindow: 1, weight: 1 }), facts("c", { assignedInWindow: 3 }), facts("d", { assignedInWindow: 1, weight: 4 }));
    expect(result).toEqual(["d", "a", "b", "c"]); // a and b tie exactly, so the id decides
  });

  it("then by who has waited longest, and a business that has never had a lead has waited longest", () => {
    const rules = withRules({ rankers: [{ type: "least_recently_assigned" }] });
    const earlier = new Date("2026-10-01T09:00:00Z");
    const later = new Date("2026-10-04T09:00:00Z");
    expect(order(rules, facts("a", { lastAssignedAt: later }), facts("b", { lastAssignedAt: earlier }), facts("c", { lastAssignedAt: null }))).toEqual(["c", "b", "a"]);
  });

  it("applies the rankers in position order: swapping them changes the winner", () => {
    const a = facts("a", { priority: 1, assignedInWindow: 9 });
    const b = facts("b", { priority: 2, assignedInWindow: 0 });
    expect(order(withRules({ rankers: [{ type: "priority" }, { type: "weighted_fairness", windowDays: 30 }] }), a, b)).toEqual(["a", "b"]);
    expect(order(withRules({ rankers: [{ type: "weighted_fairness", windowDays: 30 }, { type: "priority" }] }), a, b)).toEqual(["b", "a"]);
  });

  it("with no rankers at all still gives a deterministic answer (by id)", () => {
    expect(order(withRules({ rankers: [] }), facts("c"), facts("a"), facts("b"))).toEqual(["a", "b", "c"]);
  });
});

describe("decide", () => {
  it("ranks only the eligible, numbers them from 1, and explains the rest", () => {
    const decision = decide(ALL_ON, [
      facts("paused", { pausedUntil: new Date("2026-10-06T00:00:00Z") }),
      facts("low", { priority: 50 }),
      facts("high", { priority: 10 }),
    ]);
    expect(decision.ranking).toEqual(["high", "low"]);
    expect(decision.verdicts.map((verdict) => [verdict.clientId, verdict.rank, verdict.eligible])).toEqual([["paused", null, false], ["low", 2, true], ["high", 1, true]]);
    expect(decision.verdicts.find((verdict) => verdict.clientId === "paused")?.keys).toBeNull();
    expect(decision.verdicts.find((verdict) => verdict.clientId === "high")?.keys).toMatchObject({ priority: 10, fairness: 0 });
  });

  it("returns an empty ranking when nobody is eligible", () => {
    expect(decide(ALL_ON, [facts("a", { weight: 0 })]).ranking).toEqual([]);
    expect(decide(ALL_ON, []).ranking).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Properties, over thousands of generated situations. A small seeded generator instead of a library: failures print the seed and
// the case, so they can be replayed exactly.
// ---------------------------------------------------------------------------------------------------------------------------
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const int = (random: () => number, min: number, max: number) => min + Math.floor(random() * (max - min + 1));
const shuffle = <T,>(random: () => number, items: readonly T[]): T[] => {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
};

function randomRules(random: () => number): CompiledRules {
  const rankers: CompiledRules["rankers"] = shuffle(random, [{ type: "priority" }, { type: "weighted_fairness", windowDays: 30 }, { type: "least_recently_assigned" }] as CompiledRules["rankers"]).slice(0, int(random, 0, 3));
  return { workingHours: random() < 0.5 ? { graceMinutes: int(random, 0, 30) } : undefined, dailyCap: random() < 0.7, monthlyCap: random() < 0.7, rankers, snapshot: [] };
}

function randomFacts(random: () => number, id: string): ClientFacts {
  const dailyCap = random() < 0.5 ? null : int(random, 1, 6);
  const assignedToday = int(random, 0, 7);
  return {
    clientId: id, name: id, priority: pick(random, [0, 10, 100, 100, 500]), weight: pick(random, [0, 1, 1, 2, 5]),
    dailyCap, monthlyCap: random() < 0.5 ? null : int(random, 1, 20), assignedToday, assignedThisMonth: assignedToday + int(random, 0, 15), assignedInWindow: int(random, 0, 12),
    lastAssignedAt: random() < 0.3 ? null : new Date(1_760_000_000_000 + int(random, 0, 30) * 86_400_000),
    hours: random() < 0.5 ? [] : weekdayHours(int(random, 6, 9) * 60, int(random, 15, 19) * 60),
    localWeekday: int(random, 0, 6), localMinutes: int(random, 0, 1439),
    pausedUntil: random() < 0.15 ? new Date(1_770_000_000_000) : null, previouslyHeld: random() < 0.15,
  };
}

describe("properties of the decision (2,000 generated situations)", () => {
  const cases = Array.from({ length: 2000 }, (_, index) => {
    const random = prng(index + 1);
    const rules = randomRules(random);
    const clients = Array.from({ length: int(random, 0, 8) }, (_, n) => randomFacts(random, `c${n}`));
    return { seed: index + 1, random, rules, clients };
  });

  it("the ranking is exactly the eligible set, with nobody excluded in it and nobody counted twice", () => {
    for (const { seed, rules, clients } of cases) {
      const decision = decide(rules, clients);
      const eligible = decision.verdicts.filter((verdict) => verdict.eligible).map((verdict) => verdict.clientId).sort();
      expect([...decision.ranking].sort(), `seed ${seed}`).toEqual(eligible);
      expect(new Set(decision.ranking).size, `seed ${seed}`).toBe(decision.ranking.length);
      for (const verdict of decision.verdicts) expect(verdict.eligible, `seed ${seed}`).toBe(verdict.excludedBy.length === 0);
    }
  });

  it("the answer does not depend on the order the businesses were read in", () => {
    for (const { seed, random, rules, clients } of cases) {
      expect(decide(rules, shuffle(random, clients)).ranking, `seed ${seed}`).toEqual(decide(rules, clients).ranking);
    }
  });

  it("nobody ranked below the winner is strictly better under the rankers (the winner is genuinely first)", () => {
    for (const { seed, rules, clients } of cases) {
      const { ranking } = decide(rules, clients);
      if (ranking.length < 2) continue;
      const byId = new Map(clients.map((client) => [client.clientId, client]));
      const winner = byId.get(ranking[0]!)!;
      for (const otherId of ranking.slice(1)) {
        const other = byId.get(otherId)!;
        expect(rank(rules, [other, winner])[0]!.clientId, `seed ${seed}`).toBe(winner.clientId);
      }
    }
  });

  it("a business that reached its cap never becomes eligible by receiving MORE leads", () => {
    for (const { seed, rules, clients } of cases) {
      for (const client of clients) {
        const before = evaluateClient(rules, client);
        const busier = evaluateClient(rules, { ...client, assignedToday: client.assignedToday + 1, assignedThisMonth: client.assignedThisMonth + 1 });
        if (!before.eligible) expect(busier.eligible, `seed ${seed}`).toBe(false);
      }
    }
  });

  it("a paused, manual-only or already-had-it business is never eligible, whatever the rules", () => {
    for (const { seed, rules, clients } of cases) {
      for (const client of clients) {
        const verdict = evaluateClient(rules, client);
        if (client.pausedUntil || client.weight === 0 || client.previouslyHeld) expect(verdict.eligible, `seed ${seed}`).toBe(false);
      }
    }
  });
});

describe("fairness over time (the engine alone, one decision at a time)", () => {
  it("hands out leads in proportion to weight, to within one lead, and never to a manual-only business", () => {
    const rules = withRules({ rankers: [{ type: "priority" }, { type: "weighted_fairness", windowDays: 30 }, { type: "least_recently_assigned" }] });
    const clients = [facts("a", { weight: 1 }), facts("b", { weight: 1 }), facts("c", { weight: 2 }), facts("d", { weight: 3 }), facts("manual", { weight: 0 })];
    const counts = new Map(clients.map((client) => [client.clientId, 0]));
    const last = new Map<string, number>();
    for (let n = 1; n <= 700; n++) {
      const current = clients.map((client) => ({ ...client, assignedInWindow: counts.get(client.clientId)!, lastAssignedAt: last.has(client.clientId) ? new Date(last.get(client.clientId)!) : null }));
      const winner = decide(rules, current).ranking[0]!;
      counts.set(winner, counts.get(winner)! + 1);
      last.set(winner, n * 1000);
    }
    expect(counts.get("manual")).toBe(0);
    // 700 leads over total weight 7: a 100, b 100, c 200, d 300.
    for (const [id, expected] of [["a", 100], ["b", 100], ["c", 200], ["d", 300]] as const) {
      expect(Math.abs(counts.get(id)! - expected), id).toBeLessThanOrEqual(1);
    }
  });

  it("a business with a higher priority takes everything until it is capped, then the rest share", () => {
    const rules = ALL_ON;
    const vip = facts("vip", { priority: 1, dailyCap: 5 });
    const others = [facts("x"), facts("y")];
    const given = { vip: 0, x: 0, y: 0 } as Record<string, number>;
    for (let n = 0; n < 40; n++) {
      const current = [{ ...vip, assignedToday: given.vip!, assignedInWindow: given.vip! }, ...others.map((o) => ({ ...o, assignedInWindow: given[o.clientId]! }))];
      const winner = decide(rules, current).ranking[0]!;
      given[winner] = given[winner]! + 1;
    }
    expect(given.vip).toBe(5);
    expect(Math.abs(given.x! - given.y!)).toBeLessThanOrEqual(1);
    expect(given.x! + given.y!).toBe(35);
  });
});
