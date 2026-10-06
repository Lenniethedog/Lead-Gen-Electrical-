import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAdminAuthorizer } from "./admin-auth";
import { ACCESS_JWT_HEADER, createAccessVerifier } from "./cf-access";

const TEAM = "kentsparkmatch.cloudflareaccess.com";
const AUD = "a".repeat(64);

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let primary: Keys & { kid: string; jwk: JWK };
let other: Keys & { kid: string; jwk: JWK };

async function makeKeys(kid: string) {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" };
  return { ...pair, kid, jwk };
}

beforeAll(async () => {
  primary = await makeKeys("key-primary");
  other = await makeKeys("key-other");
});

interface TokenOptions {
  signer?: Keys & { kid: string };
  claims?: JWTPayload;
  issuer?: string;
  audience?: string | string[];
  expiresIn?: string | number;
  notBefore?: string | number;
  omitExp?: boolean;
}

async function token(options: TokenOptions = {}): Promise<string> {
  const signer = options.signer ?? primary;
  const jwt = new SignJWT({ email: "Owner@KentSparkMatch.co.uk", type: "app", ...options.claims })
    .setProtectedHeader({ alg: "RS256", kid: signer.kid })
    .setIssuer(options.issuer ?? `https://${TEAM}`)
    .setAudience(options.audience ?? AUD)
    .setSubject("user-123")
    .setIssuedAt();
  if (!options.omitExp) jwt.setExpirationTime(options.expiresIn ?? "1h");
  if (options.notBefore !== undefined) jwt.setNotBefore(options.notBefore);
  return jwt.sign(signer.privateKey);
}

const b64url = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const verifier = () => createAccessVerifier({ teamDomain: TEAM, audience: AUD }, { keys: createLocalJWKSet({ keys: [primary.jwk] }) });

describe("a valid Cloudflare Access token", () => {
  it("is accepted and yields the lowercased email and subject", async () => {
    expect(await verifier()(await token())).toEqual({ ok: true, email: "owner@kentsparkmatch.co.uk", subject: "user-123" });
  });

  it("is accepted when the audience claim is a list that includes ours", async () => {
    expect((await verifier()(await token({ audience: ["something-else", AUD] }))).ok).toBe(true);
  });
});

describe("tokens that must be refused (each is a way into the inbox if the check were weak)", () => {
  const refused = async (jwt: string | null | undefined) => (await verifier()(jwt)) as { ok: false; reason: string };

  it("no token at all", async () => {
    expect((await refused(undefined)).reason).toBe("missing");
    expect((await refused(null)).reason).toBe("missing");
    expect((await refused("")).reason).toBe("missing");
  });

  it("garbage and truncated tokens", async () => {
    for (const junk of ["abc", "a.b.c", "....", "Bearer xyz", `${b64url({ alg: "RS256" })}.${b64url({})}.`]) {
      expect((await refused(junk)).ok, junk).toBe(false);
    }
  });

  it("an oversized token is refused before any cryptography runs, even when it is validly signed", async () => {
    expect((await refused("x".repeat(100_000))).reason).toBe("malformed");
    // Access never issues tokens near this size; a valid-but-huge one is a resource-exhaustion probe.
    const huge = await token({ claims: { padding: "x".repeat(20_000) } });
    expect(huge.length).toBeGreaterThan(8_192);
    expect((await refused(huge)).reason).toBe("malformed");
  });

  it("a token issued for a DIFFERENT Access application (wrong audience)", async () => {
    expect((await refused(await token({ audience: "b".repeat(64) }))).reason).toBe("bad_audience");
  });

  it("a token from a DIFFERENT Access team (wrong issuer), even if signed by a key we trust", async () => {
    expect((await refused(await token({ issuer: "https://attacker.cloudflareaccess.com" }))).reason).toBe("bad_issuer");
  });

  it("an expired token", async () => {
    expect((await refused(await token({ expiresIn: Math.floor(Date.now() / 1000) - 3_600 }))).reason).toBe("expired");
  });

  it("a token with no expiry (it would be valid forever)", async () => {
    expect((await refused(await token({ omitExp: true }))).ok).toBe(false);
  });

  it("a token that is not valid yet", async () => {
    expect((await refused(await token({ notBefore: Math.floor(Date.now() / 1000) + 3_600 }))).ok).toBe(false);
  });

  it("a token signed by a key that is not ours", async () => {
    // Same kid as ours (an attacker copying the header) but a different private key.
    const forger = { ...(await generateKeyPair("RS256")), kid: primary.kid };
    expect((await refused(await token({ signer: forger }))).reason).toBe("bad_signature");
  });

  it("a token with a key id we have never seen", async () => {
    expect((await refused(await token({ signer: other }))).reason).toBe("unknown_key");
  });

  it("a tampered payload (email swapped after signing)", async () => {
    const [header, , signature] = (await token()).split(".");
    const forgedPayload = b64url({ email: "attacker@evil.example", iss: `https://${TEAM}`, aud: AUD, sub: "x", exp: Math.floor(Date.now() / 1000) + 3_600 });
    expect((await refused(`${header}.${forgedPayload}.${signature}`)).reason).toBe("bad_signature");
  });

  it('an unsigned token (alg: "none")', async () => {
    const forged = `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ email: "owner@kentsparkmatch.co.uk", iss: `https://${TEAM}`, aud: AUD, sub: "x", exp: Math.floor(Date.now() / 1000) + 3_600 })}.`;
    expect((await refused(forged)).ok).toBe(false);
  });

  it("the algorithm-confusion attack: HS256 signed with our PUBLIC key as the HMAC secret", async () => {
    const { createHmac } = await import("node:crypto");
    const { exportSPKI } = await import("jose");
    const publicPem = await exportSPKI(primary.publicKey);
    const head = b64url({ alg: "HS256", typ: "JWT", kid: primary.kid });
    const body = b64url({ email: "owner@kentsparkmatch.co.uk", iss: `https://${TEAM}`, aud: AUD, sub: "x", exp: Math.floor(Date.now() / 1000) + 3_600 });
    const signature = createHmac("sha256", publicPem).update(`${head}.${body}`).digest("base64url");
    expect((await refused(`${head}.${body}.${signature}`)).reason).toBe("bad_algorithm");
  });

  it("a service token (no email claim): it identifies a machine, not an operator", async () => {
    const jwt = await new SignJWT({ common_name: "ci-service" })
      .setProtectedHeader({ alg: "RS256", kid: primary.kid })
      .setIssuer(`https://${TEAM}`)
      .setAudience(AUD)
      .setSubject("svc")
      .setExpirationTime("1h")
      .sign(primary.privateKey);
    expect((await refused(jwt)).reason).toBe("no_email");
  });

  it("an email claim that is not an email", async () => {
    expect((await refused(await token({ claims: { email: "not an email" } }))).reason).toBe("no_email");
    expect((await refused(await token({ claims: { email: 42 as unknown as string } }))).reason).toBe("no_email");
  });
});

describe("fetching signing keys from the team's certs endpoint (the real network path)", () => {
  let server: Server | undefined;
  let served: { keys: JWK[] } = { keys: [] };
  let hits = 0;

  async function startKeyServer(): Promise<string> {
    server = createServer((_request, response) => {
      hits += 1;
      response.writeHead(200, { "content-type": "application/json" });
      // Cloudflare's endpoint also returns public_cert(s); extra members must be tolerated.
      response.end(JSON.stringify({ ...served, public_cert: { kid: "x", cert: "-----BEGIN CERTIFICATE-----" } }));
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/cdn-cgi/access/certs`;
  }
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    hits = 0;
  });

  it("verifies a token against keys fetched over HTTP, and caches them across requests", async () => {
    served = { keys: [primary.jwk] };
    const certsUrl = await startKeyServer();
    const verify = createAccessVerifier({ teamDomain: TEAM, audience: AUD, certsUrl });
    expect((await verify(await token())).ok).toBe(true);
    expect((await verify(await token())).ok).toBe(true);
    expect(hits).toBe(1);
  });

  it("picks up a rotated-in signing key without a restart", async () => {
    served = { keys: [primary.jwk] };
    const certsUrl = await startKeyServer();
    const verify = createAccessVerifier({ teamDomain: TEAM, audience: AUD, certsUrl }, { jwksCooldownMs: 0 });
    expect((await verify(await token())).ok).toBe(true);
    const unknown = await verify(await token({ signer: other }));
    expect(unknown).toEqual({ ok: false, reason: "unknown_key" });

    served = { keys: [primary.jwk, other.jwk] }; // Cloudflare publishes the new key
    expect((await verify(await token({ signer: other }))).ok).toBe(true);
  });

  it("fails CLOSED when the key endpoint is unreachable", async () => {
    const certsUrl = await startKeyServer();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    const verify = createAccessVerifier({ teamDomain: TEAM, audience: AUD, certsUrl });
    expect(await verify(await token())).toEqual({ ok: false, reason: "keys_unavailable" });
  });

  it("fails closed when the endpoint returns something that is not a key set", async () => {
    served = { keys: "garbage" as unknown as JWK[] };
    const certsUrl = await startKeyServer();
    const verify = createAccessVerifier({ teamDomain: TEAM, audience: AUD, certsUrl });
    expect((await verify(await token())).ok).toBe(false);
  });
});

describe("createAdminAuthorizer (who may use the inbox)", () => {
  const headersWith = (jwt?: string) => ({ get: (name: string) => (name === ACCESS_JWT_HEADER ? (jwt ?? null) : null) });
  const authorizer = (overrides: Partial<Parameters<typeof createAdminAuthorizer>[0]> = {}) =>
    createAdminAuthorizer({
      accessConfigured: true,
      verify: verifier(),
      allowedEmails: ["Owner@KentSparkMatch.co.uk"],
      allowDevBypass: false,
      ...overrides,
    });

  it("admits a valid token whose email is on the allowlist (case-insensitive), as ordinary staff", async () => {
    expect(await authorizer()(headersWith(await token()))).toEqual({ ok: true, email: "owner@kentsparkmatch.co.uk", via: "access", role: "staff" });
  });

  it("makes an owner an owner, and admits owners even if they are not also on the staff list", async () => {
    const owner = authorizer({ allowedEmails: ["someone.else@example.com"], ownerEmails: ["OWNER@kentsparkmatch.co.uk"] });
    expect(await owner(headersWith(await token()))).toEqual({ ok: true, email: "owner@kentsparkmatch.co.uk", via: "access", role: "owner" });
    // Ordinary staff never become owners by accident.
    const staff = await token({ claims: { email: "someone.else@example.com" } });
    expect(await owner(headersWith(staff))).toMatchObject({ ok: true, role: "staff" });
  });

  it("refuses a valid token whose email is NOT on the allowlist, even if Access let them through", async () => {
    const stranger = await token({ claims: { email: "stranger@example.com" } });
    expect(await authorizer()(headersWith(stranger))).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("refuses a missing or invalid token and passes the reason through for logging", async () => {
    expect(await authorizer()(headersWith())).toEqual({ ok: false, reason: "missing" });
    expect(await authorizer()(headersWith(await token({ audience: "wrong" })))).toEqual({ ok: false, reason: "bad_audience" });
  });

  it("refuses everyone when Access is not configured (fail closed)", async () => {
    expect(await authorizer({ accessConfigured: false })(headersWith(await token()))).toEqual({ ok: false, reason: "not_configured" });
  });

  it("refuses everyone when the allowlist is empty", async () => {
    expect(await authorizer({ allowedEmails: [] })(headersWith(await token()))).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("the development bypass works ONLY when explicitly allowed", async () => {
    const dev = { devEmail: "Dev@Example.com", accessConfigured: false };
    expect(await authorizer({ ...dev, allowDevBypass: true })(headersWith())).toEqual({ ok: true, email: "dev@example.com", via: "dev", role: "owner" });
    expect(await authorizer({ ...dev, allowDevBypass: false })(headersWith())).toEqual({ ok: false, reason: "not_configured" });
    // And without a dev email there is no bypass even in dev mode.
    expect(await authorizer({ allowDevBypass: true, accessConfigured: false })(headersWith())).toEqual({ ok: false, reason: "not_configured" });
  });

  it("an attacker-supplied header does not turn the bypass on (it takes no request input at all)", async () => {
    const result = await authorizer({ devEmail: "dev@example.com" })({ get: () => "x-admin-dev=1" });
    expect(result.ok).toBe(false);
  });
});
