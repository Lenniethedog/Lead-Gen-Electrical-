import { describe, expect, it } from "vitest";
import { METRES_PER_MILE, describeRule, parseClientInput, parseCoverageRule, statusNeedsReason } from "./schemas";

const valid = { name: "Dave's Roofing", contactEmail: "Dave@Example.com", acceptsExclusive: "on" };

describe("parseClientInput", () => {
  it("accepts the minimum, lower-casing the email and treating empty optional fields as absent", () => {
    const result = parseClientInput({ ...valid, legalName: "", companyNumber: "  ", contactName: "", contactPhone: "", notes: "" });
    expect(result).toEqual({
      ok: true,
      value: { name: "Dave's Roofing", legalName: undefined, companyNumber: undefined, contactName: undefined, contactEmail: "dave@example.com", contactPhone: undefined, acceptsExclusive: true, acceptsShared: false, notes: undefined },
    });
  });

  it("converts a UK phone number to E.164 and rejects nonsense", () => {
    expect(parseClientInput({ ...valid, contactPhone: "07911 123456" })).toMatchObject({ ok: true, value: { contactPhone: "+447911123456" } });
    expect(parseClientInput({ ...valid, contactPhone: "020 7946 0123" })).toMatchObject({ ok: true, value: { contactPhone: "+442079460123" } });
    expect(parseClientInput({ ...valid, contactPhone: "not a phone" })).toMatchObject({ ok: false, errors: { contactPhone: expect.any(String) } });
  });

  it("names the field that is wrong", () => {
    expect(parseClientInput({ ...valid, name: "   " })).toMatchObject({ ok: false, errors: { name: "Enter the business name" } });
    expect(parseClientInput({ ...valid, contactEmail: "nope" })).toMatchObject({ ok: false, errors: { contactEmail: expect.any(String) } });
    expect(parseClientInput({ ...valid, contactEmail: "a".repeat(250) + "@x.co" })).toMatchObject({ ok: false });
    expect(parseClientInput({ ...valid, notes: "x".repeat(2001) })).toMatchObject({ ok: false, errors: { notes: expect.any(String) } });
  });

  it("requires at least one offer type", () => {
    expect(parseClientInput({ name: "A", contactEmail: "a@b.co" })).toMatchObject({ ok: false, errors: { acceptsExclusive: expect.any(String) } });
    expect(parseClientInput({ name: "A", contactEmail: "a@b.co", acceptsShared: "on" })).toMatchObject({ ok: true, value: { acceptsShared: true, acceptsExclusive: false } });
  });

  it("reports every problem at once", () => {
    const result = parseClientInput({ name: "", contactEmail: "bad", contactPhone: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors).sort()).toEqual(["acceptsExclusive", "contactEmail", "contactPhone", "name"].sort());
  });
});

describe("parseCoverageRule", () => {
  it("normalises a postcode district", () => {
    expect(parseCoverageRule({ mode: "include", kind: "outward", outward: " br6 " })).toEqual({ ok: true, value: { mode: "include", kind: "outward", outward: "BR6" } });
    expect(parseCoverageRule({ mode: "include", kind: "outward", outward: "TN13" })).toMatchObject({ ok: true });
    for (const bad of ["", "B", "BR", "BR6 0", "BRR6", "123", "BR6'; drop table x"]) expect(parseCoverageRule({ mode: "include", kind: "outward", outward: bad }).ok, bad).toBe(false);
  });

  it("accepts a sector with or without the space and always stores it with one", () => {
    expect(parseCoverageRule({ mode: "exclude", kind: "sector", sector: "br6 0" })).toEqual({ ok: true, value: { mode: "exclude", kind: "sector", sector: "BR6 0" } });
    expect(parseCoverageRule({ mode: "exclude", kind: "sector", sector: "BR60" })).toMatchObject({ ok: true, value: { sector: "BR6 0" } });
    expect(parseCoverageRule({ mode: "exclude", kind: "sector", sector: "BR6" }).ok).toBe(false);
  });

  it("validates a postcode prefix and an area slug", () => {
    expect(parseCoverageRule({ mode: "include", kind: "postcode_prefix", postcodePrefix: "br" })).toMatchObject({ ok: true, value: { postcodePrefix: "BR" } });
    expect(parseCoverageRule({ mode: "include", kind: "postcode_prefix", postcodePrefix: "1R" }).ok).toBe(false);
    expect(parseCoverageRule({ mode: "include", kind: "area", serviceAreaSlug: "orpington" })).toMatchObject({ ok: true });
    expect(parseCoverageRule({ mode: "include", kind: "area", serviceAreaSlug: "Not A Slug" }).ok).toBe(false);
  });

  it("converts a radius in miles to metres inside the database's 500 m to 100 km bounds", () => {
    const result = parseCoverageRule({ mode: "include", kind: "radius", centerPostcode: "br6 0aa", radiusMiles: "10" });
    expect(result).toEqual({ ok: true, value: { mode: "include", kind: "radius", centerPostcode: "BR6 0AA", radiusMetres: Math.round(10 * METRES_PER_MILE) } });
    for (const miles of ["0", "0.2", "61", "-3", "abc", ""]) {
      expect(parseCoverageRule({ mode: "include", kind: "radius", centerPostcode: "BR6 0AA", radiusMiles: miles }).ok, miles).toBe(false);
    }
    // 1 mile = 1609 m >= 500 m; 60 miles = 96,561 m <= 100,000 m.
    expect(parseCoverageRule({ mode: "include", kind: "radius", centerPostcode: "BR6 0AA", radiusMiles: "60" })).toMatchObject({ ok: true });
    expect(parseCoverageRule({ mode: "include", kind: "radius", centerPostcode: "not a postcode", radiusMiles: "5" })).toMatchObject({ ok: false, errors: { centerPostcode: expect.any(String) } });
  });

  it("requires a mode and a known kind", () => {
    expect(parseCoverageRule({ kind: "outward", outward: "BR6" })).toMatchObject({ ok: false, errors: { mode: expect.any(String) } });
    expect(parseCoverageRule({ mode: "include", kind: "polygon" })).toMatchObject({ ok: false, errors: { kind: expect.any(String) } });
  });
});

describe("describeRule and statusNeedsReason", () => {
  it("words each rule kind plainly", () => {
    expect(describeRule({ kind: "outward", outward: "BR6" })).toBe("Postcode district BR6");
    expect(describeRule({ kind: "sector", sector: "BR6 0" })).toBe("Postcode sector BR6 0");
    expect(describeRule({ kind: "postcode_prefix", postcode_prefix: "BR" })).toBe('Postcodes starting "BR"');
    expect(describeRule({ kind: "area" }, "Orpington")).toBe("Area: Orpington");
    expect(describeRule({ kind: "radius", center_postcode: "BR6 0AA", radius_m: Math.round(10 * METRES_PER_MILE) })).toBe("Within 10 miles of BR6 0AA");
    expect(describeRule({ kind: "radius", center_postcode: "BR6 0AA", radius_m: 1609 })).toBe("Within 1 mile of BR6 0AA");
  });

  it("needs a reason to pause, suspend or end a client, not to activate one", () => {
    expect(["paused", "suspended", "churned"].map((status) => statusNeedsReason(status as never))).toEqual([true, true, true]);
    expect(["prospect", "active"].map((status) => statusNeedsReason(status as never))).toEqual([false, false]);
  });
});
