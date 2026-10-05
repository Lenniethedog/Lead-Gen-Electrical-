import { describe, expect, it } from "vitest";
import { initialStatus } from "./service";

describe("initialStatus precedence", () => {
  it.each([
    ["accept", false, "new"],
    ["flag", false, "new"],
    ["review", false, "held"],
    ["reject", false, "rejected_fraud"],
    ["accept", true, "duplicate"],
    ["flag", true, "duplicate"],
    ["review", true, "duplicate"],
    ["reject", true, "rejected_fraud"],
  ] as const)("decision=%s duplicate=%s -> %s", (decision, isDuplicate, expected) => {
    expect(initialStatus(decision, isDuplicate)).toBe(expected);
  });
});
