import { describe, expect, it } from "vitest";
import { normalisePostcode, outwardOf } from "./normalise";

describe("normalisePostcode", () => {
  it.each([
    ["BR6 0AA", "BR6 0AA"],
    ["br60aa", "BR6 0AA"],
    ["  br6   0aa  ", "BR6 0AA"],
    ["BR6-0AA", "BR6 0AA"],
    ["br6.0aa", "BR6 0AA"],
    ["M1 1AE", "M1 1AE"],
    ["m11ae", "M1 1AE"],
    ["B33 8TH", "B33 8TH"],
    ["CR2 6XH", "CR2 6XH"],
    ["DN55 1PT", "DN55 1PT"],
    ["SW1A 1AA", "SW1A 1AA"],
    ["sw1a1aa", "SW1A 1AA"],
    ["EC1A 1BB", "EC1A 1BB"],
    ["W1A 0AX", "W1A 0AX"],
    ["TN13 1AA", "TN13 1AA"],
  ])("normalises %j to %j", (input, expected) => {
    expect(normalisePostcode(input)).toBe(expected);
  });

  it.each([
    "",
    "BR6",
    "BR6 0A",
    "BR6 0AAA",
    "BR60AAA1",
    "1BR 0AA",
    "BR6 AAA",
    "BR6 000",
    "BRR6 0AA",
    "12345",
    "hello",
    "BR6 0AA; DROP TABLE leads",
  ])("rejects %j", (input) => {
    expect(normalisePostcode(input)).toBeNull();
  });
});

describe("outwardOf", () => {
  it("returns the district part", () => {
    expect(outwardOf("BR6 0AA")).toBe("BR6");
    expect(outwardOf("SW1A 1AA")).toBe("SW1A");
    expect(outwardOf("M1 1AE")).toBe("M1");
  });
});
