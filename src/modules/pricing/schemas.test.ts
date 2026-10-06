import { describe, expect, it } from "vitest";
import { MAX_PRICE_PENCE, formatPence, parsePoundsToPence, parsePricingRule } from "./schemas";

describe("parsePoundsToPence", () => {
  it.each([
    ["35", 3500], ["35.5", 3550], ["35.50", 3550], ["0", 0], ["0.99", 99], ["£35", 3500], [" £ 12.05 ", 1205], ["1000", 100_000],
  ])("%s -> %i pence", (input, expected) => expect(parsePoundsToPence(input)).toBe(expected));

  it.each(["", "abc", "-5", "35.555", "1,000", "1e3", "35.", ".5", "1001", "99999", "35 pounds", "NaN", "Infinity"])("rejects %j", (input) => {
    expect(parsePoundsToPence(input)).toBeUndefined();
  });

  it("uses integer arithmetic, so there are no floating-point surprises (0.1 + 0.2 style)", () => {
    expect(parsePoundsToPence("0.29")).toBe(29);
    expect(parsePoundsToPence("1.15")).toBe(115);
    expect(MAX_PRICE_PENCE).toBe(100_000);
  });
});

describe("parsePricingRule", () => {
  it("accepts a fully general rule and a fully specific one", () => {
    expect(parsePricingRule({ saleType: "exclusive", price: "35" })).toEqual({
      ok: true,
      value: { serviceSlug: null, serviceAreaSlug: null, urgency: null, saleType: "exclusive", pricePence: 3500 },
    });
    expect(parsePricingRule({ serviceSlug: "fault_repair", serviceAreaSlug: "orpington", urgency: "emergency", saleType: "shared", price: "£60.00" })).toMatchObject({
      ok: true,
      value: { serviceSlug: "fault_repair", serviceAreaSlug: "orpington", urgency: "emergency", saleType: "shared", pricePence: 6000 },
    });
  });

  it("names every wrong field", () => {
    const result = parsePricingRule({ serviceSlug: "Not A Slug", urgency: "whenever", saleType: "auction", price: "lots" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["price", "saleType", "serviceSlug", "urgency"]);
  });

  it("formats pence as pounds", () => {
    expect(formatPence(3550)).toBe("£35.50");
    expect(formatPence(0)).toBe("£0.00");
  });
});
