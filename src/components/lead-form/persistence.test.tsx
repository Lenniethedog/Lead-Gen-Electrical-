import { beforeEach, describe, expect, it } from "vitest";
import { clearPersisted, getSessionStorage, loadPersisted, savePersisted, type PersistedForm } from "./persistence";
import { EMPTY_VALUES } from "./state";

const NOW = 1_800_000_000_000;
const form: PersistedForm = {
  step: 3,
  idempotencyKey: "8d2f7c1e-5b0a-4f6e-9c3d-1a2b3c4d5e6f",
  startedAt: NOW - 90_000,
  values: {
    ...EMPTY_VALUES,
    service: "roof_repair",
    postcode: "BR6 0AA",
    coverage: { postcode: "BR6 0AA", areaName: "Orpington" },
    propertyType: "house",
    ownership: "owner",
    scope: "leak",
    name: "Alex",
  },
};

beforeEach(() => sessionStorage.clear());

describe("form persistence", () => {
  it("round-trips progress", () => {
    savePersisted(sessionStorage, form, NOW);
    expect(loadPersisted(sessionStorage, NOW + 1_000)).toEqual(form);
  });

  it("never stores consent (it is not part of the persisted shape)", () => {
    savePersisted(sessionStorage, form, NOW);
    expect(sessionStorage.getItem("leadform.v1")).not.toMatch(/consent/i);
  });

  it("discards progress older than two hours, and deletes it", () => {
    savePersisted(sessionStorage, form, NOW);
    expect(loadPersisted(sessionStorage, NOW + 2 * 60 * 60 * 1000 + 1)).toBeNull();
    expect(sessionStorage.getItem("leadform.v1")).toBeNull();
  });

  it("discards clock-skewed data from the future", () => {
    savePersisted(sessionStorage, form, NOW + 10 * 60_000);
    expect(loadPersisted(sessionStorage, NOW)).toBeNull();
  });

  it.each([
    ["not json", "{oops"],
    ["wrong version", JSON.stringify({ v: 2, savedAt: NOW, ...form })],
    ["unknown service", JSON.stringify({ v: 1, savedAt: NOW, ...form, values: { ...form.values, service: "plumbing" } })],
    ["step out of range", JSON.stringify({ v: 1, savedAt: NOW, ...form, step: 99 })],
    ["bad idempotency key", JSON.stringify({ v: 1, savedAt: NOW, ...form, idempotencyKey: "short" })],
    ["oversized field", JSON.stringify({ v: 1, savedAt: NOW, ...form, values: { ...form.values, notes: "x".repeat(5000) } })],
  ])("treats %s as no saved progress instead of crashing", (_label, raw) => {
    sessionStorage.setItem("leadform.v1", raw);
    expect(loadPersisted(sessionStorage, NOW)).toBeNull();
  });

  it("clears on request", () => {
    savePersisted(sessionStorage, form, NOW);
    clearPersisted(sessionStorage);
    expect(loadPersisted(sessionStorage, NOW)).toBeNull();
  });

  it("never throws when storage is unavailable, blocked or full", () => {
    expect(loadPersisted(null, NOW)).toBeNull();
    expect(() => savePersisted(null, form, NOW)).not.toThrow();
    expect(() => clearPersisted(null)).not.toThrow();

    const hostile = {
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
    } as unknown as Storage;
    expect(loadPersisted(hostile, NOW)).toBeNull();
    expect(() => savePersisted(hostile, form, NOW)).not.toThrow();
    expect(() => clearPersisted(hostile)).not.toThrow();
  });

  it("finds sessionStorage in a normal browser context", () => {
    expect(getSessionStorage()).toBe(window.sessionStorage);
  });
});
