import { describe, expect, it } from "vitest";
import { attributionSchema, classifySource, SOURCE_SLUGS, type Attribution } from "./index";

describe("classifySource", () => {
  const cases: Array<[string, Attribution, string]> = [
    ["gclid proves Google Ads even without UTMs", { gclid: "EAIaIQobChMI" }, "google_ads"],
    ["utm google + cpc", { utmSource: "google", utmMedium: "cpc" }, "google_ads"],
    ["utm google + ppc (case-insensitive)", { utmSource: "Google", utmMedium: "PPC" }, "google_ads"],
    ["msclkid proves Microsoft Ads", { msclkid: "abc123" }, "bing_ads"],
    ["utm bing + cpc", { utmSource: "bing", utmMedium: "cpc" }, "bing_ads"],
    ["utm facebook + paid_social", { utmSource: "facebook", utmMedium: "paid_social" }, "meta_ads"],
    ["utm instagram + cpc", { utmSource: "instagram", utmMedium: "cpc" }, "meta_ads"],
    [
      "fbclid alone is NOT paid evidence (every outbound Facebook click carries it)",
      { fbclid: "IwAR0xyz" },
      "direct",
    ],
    [
      "fbclid with organic referrer stays referral",
      { fbclid: "IwAR0xyz", referrerHost: "l.facebook.com" },
      "referral",
    ],
    ["search engine referrer is organic search", { referrerHost: "www.google.co.uk" }, "organic_search"],
    ["duckduckgo referrer is organic search", { referrerHost: "duckduckgo.com" }, "organic_search"],
    ["other referrer is a referral", { referrerHost: "news.example.org" }, "referral"],
    ["own host referrer is ignored", { referrerHost: "localhost" }, "direct"],
    ["no evidence at all is direct", {}, "direct"],
    ["utm google but organic medium is not paid", { utmSource: "google", utmMedium: "organic" }, "direct"],
    ["paid beats referrer: gclid wins over a search referrer", { gclid: "x", referrerHost: "www.google.com" }, "google_ads"],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    expect(classifySource(input, "localhost")).toBe(expected);
  });

  it("only ever returns slugs that are seeded as lead sources", () => {
    for (const [, input] of cases) expect(SOURCE_SLUGS).toContain(classifySource(input, "localhost"));
  });
});

describe("attributionSchema", () => {
  it("keeps well-formed values", () => {
    const parsed = attributionSchema.parse({
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "21098765432",
      gclid: "EAIaIQobChMI",
      landingPath: "/electrician-fault-repair",
      referrerHost: "www.google.com",
    });
    expect(parsed).toMatchObject({ utmSource: "google", landingPath: "/electrician-fault-repair", referrerHost: "www.google.com" });
  });

  it("strips control characters and truncates long values instead of rejecting", () => {
    const parsed = attributionSchema.parse({ utmCampaign: `spring\n\u0000sale${"x".repeat(500)}` });
    expect(parsed.utmCampaign).toBeDefined();
    expect(parsed.utmCampaign).toHaveLength(200);
    expect(parsed.utmCampaign).not.toMatch(/[\u0000-\u001f]/);
  });

  it("reduces the landing page to a bare path (query strings can carry personal data)", () => {
    expect(attributionSchema.parse({ landingPath: "/page?email=a@b.com#frag" }).landingPath).toBe("/page");
    expect(attributionSchema.parse({ landingPath: "https://evil.example/x" }).landingPath).toBeUndefined();
  });

  it("accepts only a plain hostname as the referrer", () => {
    expect(attributionSchema.parse({ referrerHost: "https://www.google.com/search?q=electrician" }).referrerHost).toBeUndefined();
    expect(attributionSchema.parse({ referrerHost: "Sub.Example.CO.UK" }).referrerHost).toBe("sub.example.co.uk");
  });

  it("tolerates garbage of any shape", () => {
    for (const junk of [null, 5, "x", [], { utmSource: { a: 1 } }]) {
      expect(() => attributionSchema.parse(junk)).not.toThrow();
    }
  });
});
