import { describe, expect, it } from "vitest";
import { generateLeadReference, LEAD_REFERENCE_PATTERN } from "./ids";

describe("generateLeadReference", () => {
  it("matches the format the database constraint enforces", () => {
    for (let i = 0; i < 200; i += 1) expect(generateLeadReference()).toMatch(LEAD_REFERENCE_PATTERN);
  });

  it("never uses the ambiguous letters I, L, O or U", () => {
    const sample = Array.from({ length: 500 }, generateLeadReference).join("");
    expect(sample.replace(/L-|-/g, "")).not.toMatch(/[ILOU]/);
  });

  it("does not repeat across a large sample", () => {
    const refs = new Set(Array.from({ length: 5_000 }, generateLeadReference));
    expect(refs.size).toBe(5_000);
  });
});
