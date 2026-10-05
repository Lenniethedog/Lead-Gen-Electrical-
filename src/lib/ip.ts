import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export type TrustProxy = "none" | "cloudflare" | "forwarded";

export interface ClientIpConfig {
  mode: TrustProxy;
  /** forwarded mode: number of trusted proxies in front of the app. */
  trustedHops: number;
  /** cloudflare mode: expected value of the X-Origin-Verify header. */
  originSecret?: string | undefined;
}

/** Validates and canonicalises an address from a header ("::ffff:1.2.3.4" -> "1.2.3.4"). */
export function normaliseIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1]) value = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(value)) value = value.slice(0, value.lastIndexOf(":"));
  if (value.toLowerCase().startsWith("::ffff:") && isIP(value.slice(7)) === 4) value = value.slice(7);
  return isIP(value) === 0 ? null : value.toLowerCase();
}

/** Constant-time comparison of the origin secret (digests first, so length does not leak). */
export function hasValidOriginSecret(headers: Headers, secret: string | undefined): boolean {
  if (!secret) return false;
  const presented = headers.get("x-origin-verify");
  if (!presented) return false;
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

/**
 * Best-effort client address. The Web Request that Next.js hands to route handlers does not expose
 * the TCP peer, and Next only fills in X-Forwarded-For when it is absent (it never appends), so the
 * header is attacker-controlled unless a proxy we operate rewrites it. Hence three explicit modes:
 *
 *   none        - return null. Never guess. IP-based signals are simply inactive.
 *   cloudflare  - trust CF-Connecting-IP only when the request also proves it came through our
 *                 Cloudflare zone (X-Origin-Verify secret). Otherwise null.
 *   forwarded   - take the entry `trustedHops` positions from the right of X-Forwarded-For.
 */
export function resolveClientIp(headers: Headers, config: ClientIpConfig): string | null {
  switch (config.mode) {
    case "none":
      return null;
    case "cloudflare":
      return hasValidOriginSecret(headers, config.originSecret)
        ? normaliseIp(headers.get("cf-connecting-ip"))
        : null;
    case "forwarded": {
      const entries = (headers.get("x-forwarded-for") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
      return normaliseIp(entries[entries.length - config.trustedHops]);
    }
  }
}

/** Cloudflare's two-letter country (or XX unknown, T1 Tor), trusted under the same rule as the IP. */
export function resolveCountry(headers: Headers, config: ClientIpConfig): string | null {
  if (config.mode !== "cloudflare" || !hasValidOriginSecret(headers, config.originSecret)) return null;
  const value = headers.get("cf-ipcountry")?.trim().toUpperCase();
  return value && /^[A-Z0-9]{2}$/.test(value) ? value : null;
}
