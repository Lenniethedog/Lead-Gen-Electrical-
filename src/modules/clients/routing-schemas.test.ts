import { describe, expect, it } from "vitest";
import { parsePause, parseRoutingPreferences, parseWorkingHours } from "./routing-schemas";

describe("routing preferences", () => {
  it("accepts a normal setting, and empty caps mean no limit", () => {
    expect(parseRoutingPreferences({ priority: "100", weight: "1", dailyLeadCap: "", monthlyLeadCap: "" })).toEqual({ ok: true, value: { priority: 100, weight: 1, dailyLeadCap: null, monthlyLeadCap: null } });
    expect(parseRoutingPreferences({ priority: "0", weight: "0", dailyLeadCap: "5", monthlyLeadCap: "60" })).toEqual({ ok: true, value: { priority: 0, weight: 0, dailyLeadCap: 5, monthlyLeadCap: 60 } });
  });

  it("names every problem at once", () => {
    const result = parseRoutingPreferences({ priority: "-1", weight: "101", dailyLeadCap: "0", monthlyLeadCap: "abc" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["dailyLeadCap", "monthlyLeadCap", "priority", "weight"]);
  });

  it("rejects fractions, exponents, signs and absurd sizes", () => {
    for (const bad of ["1.5", "1e3", "+5", " ", "", "1001", "99999999"]) expect(parseRoutingPreferences({ priority: bad, weight: "1", dailyLeadCap: "", monthlyLeadCap: "" }).ok, bad).toBe(false);
  });

  it("refuses a monthly limit below the daily one", () => {
    const result = parseRoutingPreferences({ priority: "100", weight: "1", dailyLeadCap: "10", monthlyLeadCap: "5" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.monthlyLeadCap).toMatch(/cannot be lower/);
  });
});

describe("working hours", () => {
  const week = (overrides: Record<string, string> = {}) => ({
    limitHours: "on",
    opens_1: "08:00", closes_1: "17:00", opens_2: "08:00", closes_2: "17:00", opens_3: "08:00", closes_3: "17:00", opens_4: "08:00", closes_4: "17:00", opens_5: "08:00", closes_5: "13:00",
    ...overrides,
  });

  it("unticked means no restriction at all, whatever times are filled in", () => {
    expect(parseWorkingHours({ opens_1: "08:00", closes_1: "17:00" })).toEqual({ ok: true, value: { windows: [] } });
  });

  it("an open day needs both times; a day with neither is closed", () => {
    const result = parseWorkingHours(week());
    expect(result).toEqual({ ok: true, value: { windows: [1, 2, 3, 4].map((weekday) => ({ weekday, opens: "08:00", closes: "17:00" })).concat([{ weekday: 5, opens: "08:00", closes: "13:00" }]) } });
  });

  it("points at the day that is wrong", () => {
    const half = parseWorkingHours(week({ closes_2: "" }));
    expect(half.ok).toBe(false);
    if (!half.ok) expect(half.errors.opens_2).toMatch(/Tuesday: enter both/);
    const backwards = parseWorkingHours(week({ opens_3: "18:00" }));
    if (!backwards.ok) expect(backwards.errors.closes_3).toMatch(/Wednesday: it must close after it opens/);
    const junk = parseWorkingHours(week({ opens_1: "8am" }));
    if (!junk.ok) expect(junk.errors.opens_1).toMatch(/Monday: enter the opening time/);
    expect([half.ok, backwards.ok, junk.ok]).toEqual([false, false, false]);
  });

  it("refuses a restriction that is never open", () => {
    const result = parseWorkingHours({ limitHours: "on" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.limitHours).toMatch(/at least one open day/);
  });

  it("rejects impossible times", () => {
    for (const bad of ["24:00", "12:60", "7:00", "12:5"]) expect(parseWorkingHours(week({ opens_1: bad })).ok, bad).toBe(false);
  });
});

describe("pauses", () => {
  const base = { from: "2026-10-12T09:00", until: "2026-10-19T09:00", reason: "holiday" };
  it("accepts a valid pause", () => expect(parsePause(base)).toEqual({ ok: true, value: base }));
  it("needs it to end after it starts, real dates, and a reason from the list", () => {
    expect(parsePause({ ...base, until: "2026-10-12T09:00" }).ok).toBe(false);
    expect(parsePause({ ...base, until: "2026-10-01T09:00" }).ok).toBe(false);
    expect(parsePause({ ...base, from: "2026-13-01T09:00" }).ok).toBe(false);
    expect(parsePause({ ...base, from: "tomorrow" }).ok).toBe(false);
    expect(parsePause({ ...base, reason: "because" }).ok).toBe(false);
    expect(parsePause({ ...base, reason: "" }).ok).toBe(false);
  });
});
