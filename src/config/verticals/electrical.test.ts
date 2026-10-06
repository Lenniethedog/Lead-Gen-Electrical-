import { describe, expect, it } from "vitest";
import { URGENCIES } from "@/config/lead-options";
import { ELECTRICAL_EMERGENCY } from "@/config/safety";
import { ELECTRICAL, isServiceSlug, isValidScope, SERVICE_SLUGS, SERVICES } from "./electrical";

// The database CHECKs slugs against this (db/migrations/0001).
const SLUG = /^[a-z][a-z0-9_]*$/;

describe("the electrical services", () => {
  it("are fault repair, consumer unit, rewire, EICR, EV charger, lighting and sockets, and something else (last)", () => {
    expect(SERVICE_SLUGS).toEqual(["fault_repair", "consumer_unit", "rewire", "eicr", "ev_charger", "lighting_sockets", "other"]);
    expect(ELECTRICAL).toEqual({ slug: "electrical", name: "Electrical", duplicateWindowDays: 14 });
    for (const slug of SERVICE_SLUGS) expect(slug).toMatch(SLUG);
    expect(ELECTRICAL.slug).toMatch(SLUG);
  });

  it("give every service a label, a hint and at least two distinct answers to the follow-up question", () => {
    for (const slug of SERVICE_SLUGS) {
      const { label, hint, scopes } = SERVICES[slug];
      expect(label.trim()).not.toBe("");
      expect(hint.trim()).not.toBe("");
      const values = scopes.map((scope) => scope.value);
      expect(values.length).toBeGreaterThanOrEqual(2);
      expect(new Set(values).size).toBe(values.length);
      for (const value of values) {
        expect(value).toMatch(SLUG);
        expect(value.length).toBeLessThanOrEqual(60); // the form persists scope as max 60 characters
      }
    }
  });

  it("keep inspection (EICR) and EV chargers as services of their own, because a business that does one often does not do the other (docs/00 E2)", () => {
    expect(SERVICES.eicr.scopes.map((scope) => scope.value)).toContain("landlord_certificate");
    expect(SERVICES.ev_charger.scopes.map((scope) => scope.value)).toContain("home_charger");
    for (const slug of SERVICE_SLUGS.filter((s) => s !== "ev_charger")) {
      expect(SERVICES[slug].scopes.some((scope) => /charger/i.test(`${scope.value} ${scope.label}`))).toBe(false);
    }
  });

  it("validate answers against their own service", () => {
    expect(isServiceSlug("rewire")).toBe(true);
    expect(isServiceSlug("roof_repair")).toBe(false);
    expect(isValidScope("rewire", "full_rewire")).toBe(true);
    expect(isValidScope("fault_repair", "full_rewire")).toBe(false);
    expect(isValidScope("eicr", "landlord_certificate")).toBe(true);
  });

  it("explain an urgent electrical job as no power or an unsafe feeling", () => {
    expect(URGENCIES.emergency).toEqual({ label: "Urgent", hint: "There's no power, or it feels unsafe right now" });
  });

  it("make no claim about the businesses that we cannot prove (docs/00 E4)", () => {
    const text = JSON.stringify({ SERVICES, ELECTRICAL_EMERGENCY }).toLowerCase();
    for (const claim of ["vetted", "trusted", "approved", "accredited", "insured", "guaranteed", "niceic", "napit", "part p", "registered electrician"]) {
      expect(text, claim).not.toContain(claim);
    }
  });
});

describe("electrical emergencies", () => {
  it("send a fire or an injury to 999 and a power cut or fallen cable to 105, on dialable numbers", () => {
    expect(ELECTRICAL_EMERGENCY.phone).toEqual({ display: "999", tel: "999" });
    expect(ELECTRICAL_EMERGENCY.powerCut).toMatchObject({ display: "105", tel: "105" });
    expect(ELECTRICAL_EMERGENCY.body).toMatch(/call 999/i);
    expect(ELECTRICAL_EMERGENCY.powerCut.body).toMatch(/24 hours/);
    expect(ELECTRICAL_EMERGENCY.headline).toMatch(/shock/i);
  });

  it("tell nobody to touch the wiring, and to switch off only if it is safe to", () => {
    expect(ELECTRICAL_EMERGENCY.body).toMatch(/if it's safe to/i);
    expect(ELECTRICAL_EMERGENCY.body).toMatch(/keep away from damaged wiring/i);
  });
});
