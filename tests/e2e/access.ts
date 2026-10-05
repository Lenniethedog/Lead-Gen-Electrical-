import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importJWK, SignJWT, type JWK } from "jose";

/** Must match the environment the web server is started with in playwright.config.ts. */
export const E2E_ACCESS = {
  teamDomain: "e2e.cloudflareaccess.com",
  audience: "e2e".padEnd(64, "a"),
  /** Ordinary staff. */
  operator: "operator@e2e.example",
  /** May also erase leads. */
  owner: "owner@e2e.example",
  stranger: "stranger@e2e.example",
  header: "cf-access-jwt-assertion",
};

const keyFile = process.env.E2E_ACCESS_KEY_FILE ?? path.join(tmpdir(), "leadgen-e2e-access-key.json");

export interface TokenOptions {
  email?: string;
  audience?: string;
  issuer?: string;
  /** Seconds from now; negative = already expired. */
  expiresIn?: number;
}

/** A token the app will accept (unless the options make it wrong on purpose). Signed with the key the mock Access server generated. */
export async function accessToken(options: TokenOptions = {}): Promise<string> {
  const { kid, privateJwk } = JSON.parse(readFileSync(keyFile, "utf8")) as { kid: string; privateJwk: JWK };
  const key = await importJWK(privateJwk, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: options.email ?? E2E_ACCESS.operator, type: "app" })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(options.issuer ?? `https://${E2E_ACCESS.teamDomain}`)
    .setAudience(options.audience ?? E2E_ACCESS.audience)
    .setSubject("e2e-user")
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresIn ?? 3600))
    .sign(key);
}
