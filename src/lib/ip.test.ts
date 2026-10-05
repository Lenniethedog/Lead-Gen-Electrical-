import { describe, expect, it } from "vitest";
import { hasValidOriginSecret, normaliseIp, resolveClientIp, resolveCountry, type ClientIpConfig } from "./ip";

const SECRET = "a-long-random-origin-secret-value-123";

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe("normaliseIp", () => {
  it.each([
    ["203.0.113.7", "203.0.113.7"],
    ["::ffff:203.0.113.7", "203.0.113.7"],
    ["203.0.113.7:51234", "203.0.113.7"],
    ["[2001:DB8::1]:443", "2001:db8::1"],
    ["2001:db8::1", "2001:db8::1"],
    [" 203.0.113.7 ", "203.0.113.7"],
  ])("canonicalises %s", (input, expected) => {
    expect(normaliseIp(input)).toBe(expected);
  });

  it.each(["", "unknown", "999.1.1.1", "1.2.3", "<script>", "203.0.113.7, 198.51.100.1"])(
    "rejects %j",
    (input) => {
      expect(normaliseIp(input)).toBeNull();
    },
  );

  it("handles null and undefined", () => {
    expect(normaliseIp(null)).toBeNull();
    expect(normaliseIp(undefined)).toBeNull();
  });
});

describe("resolveClientIp", () => {
  describe("mode none", () => {
    const config: ClientIpConfig = { mode: "none", trustedHops: 1 };
    it("never trusts any header, however convincing", () => {
      const h = headers({ "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8", "x-origin-verify": SECRET });
      expect(resolveClientIp(h, config)).toBeNull();
    });
  });

  describe("mode cloudflare", () => {
    const config: ClientIpConfig = { mode: "cloudflare", trustedHops: 1, originSecret: SECRET };

    it("trusts CF-Connecting-IP only when the origin secret proves the request came via Cloudflare", () => {
      const h = headers({ "cf-connecting-ip": "203.0.113.7", "x-origin-verify": SECRET });
      expect(resolveClientIp(h, config)).toBe("203.0.113.7");
    });

    it("ignores a forged CF-Connecting-IP when the secret is missing or wrong", () => {
      expect(resolveClientIp(headers({ "cf-connecting-ip": "203.0.113.7" }), config)).toBeNull();
      expect(
        resolveClientIp(headers({ "cf-connecting-ip": "203.0.113.7", "x-origin-verify": "wrong" }), config),
      ).toBeNull();
    });

    it("returns null for a garbage address even with a valid secret", () => {
      expect(resolveClientIp(headers({ "cf-connecting-ip": "not-an-ip", "x-origin-verify": SECRET }), config)).toBeNull();
    });

    it("never trusts anything when no secret is configured", () => {
      const noSecret: ClientIpConfig = { mode: "cloudflare", trustedHops: 1 };
      expect(resolveClientIp(headers({ "cf-connecting-ip": "203.0.113.7", "x-origin-verify": "x" }), noSecret)).toBeNull();
    });
  });

  describe("mode forwarded", () => {
    it("takes the entry `trustedHops` from the right, ignoring client-supplied entries on the left", () => {
      const h = headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7" });
      expect(resolveClientIp(h, { mode: "forwarded", trustedHops: 1 })).toBe("203.0.113.7");
    });

    it("supports multiple trusted proxies", () => {
      const h = headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.7, 10.0.0.2" });
      expect(resolveClientIp(h, { mode: "forwarded", trustedHops: 2 })).toBe("203.0.113.7");
    });

    it("works when the proxy overwrites the header with a single address", () => {
      expect(resolveClientIp(headers({ "x-forwarded-for": "203.0.113.7" }), { mode: "forwarded", trustedHops: 1 })).toBe(
        "203.0.113.7",
      );
    });

    it("returns null when there are fewer entries than trusted hops, or no header", () => {
      expect(resolveClientIp(headers({ "x-forwarded-for": "203.0.113.7" }), { mode: "forwarded", trustedHops: 2 })).toBeNull();
      expect(resolveClientIp(headers({}), { mode: "forwarded", trustedHops: 1 })).toBeNull();
    });
  });
});

describe("hasValidOriginSecret / resolveCountry", () => {
  it("compares the secret exactly", () => {
    expect(hasValidOriginSecret(headers({ "x-origin-verify": SECRET }), SECRET)).toBe(true);
    expect(hasValidOriginSecret(headers({ "x-origin-verify": `${SECRET}x` }), SECRET)).toBe(false);
    expect(hasValidOriginSecret(headers({}), SECRET)).toBe(false);
    expect(hasValidOriginSecret(headers({ "x-origin-verify": SECRET }), undefined)).toBe(false);
  });

  it("only believes CF-IPCountry under the same proof", () => {
    const config: ClientIpConfig = { mode: "cloudflare", trustedHops: 1, originSecret: SECRET };
    expect(resolveCountry(headers({ "cf-ipcountry": "gb", "x-origin-verify": SECRET }), config)).toBe("GB");
    expect(resolveCountry(headers({ "cf-ipcountry": "GB" }), config)).toBeNull();
    expect(resolveCountry(headers({ "cf-ipcountry": "GB" }), { mode: "none", trustedHops: 1 })).toBeNull();
    expect(resolveCountry(headers({ "cf-ipcountry": "<x>", "x-origin-verify": SECRET }), config)).toBeNull();
  });
});
