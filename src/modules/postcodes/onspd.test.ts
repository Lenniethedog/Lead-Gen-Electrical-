import { describe, expect, it } from "vitest";
import { areaOf, OnspdFormatError, parseYearMonth, resolveColumns, transformRow } from "./onspd";

const modernHeaders = ["pcd", "pcd2", "pcds", "dointr", "doterm", "usertype", "oseast1m", "osnrth1m", "lat", "long", "lad25cd", "rgn25cd", "ctry25cd"];
const legacyHeaders = ["pcd", "pcd2", "pcds", "dointr", "doterm", "lat", "long", "laua", "rgn", "ctry"];

describe("resolveColumns", () => {
  it("finds year-suffixed geography columns in a modern edition", () => {
    expect(resolveColumns(modernHeaders)).toEqual({
      postcode: "pcds", lat: "lat", lng: "long", introduced: "dointr", terminated: "doterm",
      district: "lad25cd", region: "rgn25cd", country: "ctry25cd",
    });
  });

  it("also understands the older unsuffixed names, and any year", () => {
    expect(resolveColumns(legacyHeaders)).toMatchObject({ district: "laua", region: "rgn", country: "ctry" });
    expect(resolveColumns([...modernHeaders.filter((h) => !h.endsWith("25cd")), "lad31cd"]).district).toBe("lad31cd");
  });

  it("is case-insensitive about headers and tolerant of optional columns being absent", () => {
    const columns = resolveColumns(["PCDS", "LAT", "LONG"]);
    expect(columns).toMatchObject({ postcode: "PCDS", lat: "LAT", lng: "LONG", district: null, terminated: null });
  });

  it("refuses a file that is not an ONSPD extract, naming what is missing and what was found", () => {
    expect(() => resolveColumns(["postcode", "latitude", "longitude"])).toThrowError(OnspdFormatError);
    expect(() => resolveColumns(["postcode", "latitude", "longitude"])).toThrowError(/pcds.*lat.*long/s);
    expect(() => resolveColumns(["pcds", "lat"])).toThrowError(/long/);
  });
});

describe("transformRow", () => {
  const columns = resolveColumns(modernHeaders);
  const row = (overrides: Record<string, string>) => ({
    pcd: "BR6  0AA", pcd2: "BR6 0AA", pcds: "BR6 0AA", dointr: "198001", doterm: "", usertype: "0",
    oseast1m: "545000", osnrth1m: "164000", lat: "51.373000", long: "0.099700",
    lad25cd: "E09000006", rgn25cd: "E12000007", ctry25cd: "E92000001", ...overrides,
  });

  it("maps a live postcode", () => {
    expect(transformRow(row({}), columns)).toEqual({
      postcode: "BR6 0AA", lat: 51.373, lng: 0.0997, districtCode: "E09000006", regionCode: "E12000007",
      countryCode: "E92000001", introducedOn: "1980-01-01", terminatedOn: null,
    });
  });

  it("records termination without discarding the row (historic leads must keep a valid postcode)", () => {
    expect(transformRow(row({ doterm: "201012" }), columns)?.terminatedOn).toBe("2010-12-01");
  });

  it("treats ONS's 'no grid reference' sentinel as missing coordinates, both together", () => {
    const result = transformRow(row({ lat: "99.999999", long: "0.000000" }), columns);
    expect(result).toMatchObject({ postcode: "BR6 0AA", lat: null, lng: null });
  });

  it("drops a half-missing or out-of-range coordinate pair rather than storing half a location", () => {
    expect(transformRow(row({ long: "" }), columns)).toMatchObject({ lat: null, lng: null });
    expect(transformRow(row({ lat: "12.5" }), columns)).toMatchObject({ lat: null, lng: null });
  });

  it("normalises the postcode and skips anything that is not a UK postcode", () => {
    expect(transformRow(row({ pcds: "br60aa" }), columns)?.postcode).toBe("BR6 0AA");
    expect(transformRow(row({ pcds: "" }), columns)).toBeNull();
    expect(transformRow(row({ pcds: "ZZZ" }), columns)).toBeNull();
  });

  it("leaves optional geography null when the column is absent or blank", () => {
    expect(transformRow(row({ lad25cd: "" }), columns)?.districtCode).toBeNull();
    const minimal = resolveColumns(["pcds", "lat", "long"]);
    expect(transformRow({ pcds: "BR6 0AA", lat: "51.3", long: "0.1" }, minimal)).toMatchObject({ districtCode: null, introducedOn: null });
  });
});

describe("helpers", () => {
  it("parses year-month dates strictly", () => {
    expect(parseYearMonth("198001")).toBe("1980-01-01");
    for (const bad of ["", undefined, "1980", "198013", "19800101", "abcdef", "198000"]) expect(parseYearMonth(bad)).toBeNull();
  });

  it("extracts the postcode area", () => {
    expect(areaOf("BR6 0AA")).toBe("BR");
    expect(areaOf("SW1A 1AA")).toBe("SW");
    expect(areaOf("M1 1AE")).toBe("M");
    expect(areaOf("TN13 1AA")).toBe("TN");
  });
});
