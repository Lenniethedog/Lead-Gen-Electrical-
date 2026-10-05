import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Verifies the JWT that Cloudflare Access attaches to every request it lets through
 * (`Cf-Access-Jwt-Assertion`). The inbox shows consumers' phone numbers, so it is NOT enough to rely
 * on Access being configured at the edge: anyone who finds the origin URL, or a misconfigured Access
 * policy, would bypass it. The app therefore proves every request carries a token that
 *   - is signed (RS256 only) by this team's Access keys (fetched from the team's certs endpoint),
 *   - was issued for THIS application (audience tag) by THIS team (issuer),
 *   - is current (exp required, small clock tolerance),
 *   - identifies a person (an email claim: service tokens have none and are refused).
 * Everything else fails closed with a reason code that is safe to log.
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type AccessFailure =
  | "missing"
  | "malformed"
  | "expired"
  | "bad_signature"
  | "bad_audience"
  | "bad_issuer"
  | "bad_algorithm"
  | "unknown_key"
  | "no_email"
  | "keys_unavailable";

export type AccessResult = { ok: true; email: string; subject: string } | { ok: false; reason: AccessFailure };

export interface AccessConfig {
  /** <team>.cloudflareaccess.com */
  teamDomain: string;
  /** The Access application's audience (AUD) tag. */
  audience: string;
  /** Override where signing keys come from. Tests only; defaults to the team's certs endpoint. */
  certsUrl?: string | undefined;
}

export interface AccessVerifierOptions {
  /** Inject keys (tests). Defaults to the team's remote key set, cached and refreshed on rotation. */
  keys?: JWTVerifyGetKey;
  /** Minimum time between refetches of the key set when an unknown key id is seen. */
  jwksCooldownMs?: number;
  clockToleranceSeconds?: number;
}

/** A real Access token is ~1 KB. Refusing anything large keeps this cheap to call on every request. */
const MAX_TOKEN_LENGTH = 8_192;

function classify(error: unknown): AccessFailure {
  if (error instanceof errors.JWTExpired) return "expired";
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") return "bad_audience";
    if (error.claim === "iss") return "bad_issuer";
    if (error.claim === "exp") return "expired";
    return "malformed";
  }
  if (error instanceof errors.JOSEAlgNotAllowed) return "bad_algorithm";
  if (error instanceof errors.JWSSignatureVerificationFailed) return "bad_signature";
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) return "unknown_key";
  if (error instanceof errors.JWKSTimeout || error instanceof errors.JWKSInvalid) return "keys_unavailable";
  if (error instanceof errors.JWSInvalid || error instanceof errors.JWTInvalid) return "malformed";
  // Anything else (a failed fetch of the key set, a malformed key) must not let a request through.
  return "keys_unavailable";
}

export function createAccessVerifier(
  config: AccessConfig,
  options: AccessVerifierOptions = {},
): (token: string | null | undefined) => Promise<AccessResult> {
  const issuer = `https://${config.teamDomain}`;
  const keys =
    options.keys ??
    createRemoteJWKSet(new URL(config.certsUrl ?? `${issuer}/cdn-cgi/access/certs`), {
      timeoutDuration: 3_000,
      cooldownDuration: options.jwksCooldownMs ?? 30_000,
      cacheMaxAge: 10 * 60_000,
    });

  return async (token) => {
    if (!token) return { ok: false, reason: "missing" };
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed" };
    try {
      const { payload } = await jwtVerify(token, keys, {
        issuer,
        audience: config.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iss", "aud", "sub"],
        clockTolerance: options.clockToleranceSeconds ?? 5,
      });
      const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
      if (email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) return { ok: false, reason: "no_email" };
      return { ok: true, email, subject: String(payload.sub) };
    } catch (error) {
      return { ok: false, reason: classify(error) };
    }
  };
}
