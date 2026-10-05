import "server-only";
import { createAdminAuthorizer, type AdminAuthResult, type HeaderReader } from "@/lib/admin-auth";
import { createAccessVerifier } from "@/lib/cf-access";
import { getServerEnv } from "@/lib/env";

/**
 * Wires the admin authorisation policy (src/lib/admin-auth.ts) to this deployment's settings.
 * Used by BOTH the proxy (first gate, before any page code runs) and the data-access layer (every
 * page and every server action re-checks, because an action is reachable by a direct POST).
 *
 * Kept on globalThis: the proxy and the app routes are bundled separately but share one process,
 * and the key-set cache inside the verifier must be shared, not rebuilt per bundle or per request.
 */
export type Authorizer = (headers: HeaderReader) => Promise<AdminAuthResult>;

const globalForAuth = globalThis as typeof globalThis & { __leadgenAdminAuthorizer?: Authorizer };

export function getAdminAuthorizer(): Authorizer {
  if (!globalForAuth.__leadgenAdminAuthorizer) {
    const env = getServerEnv();
    const accessConfigured = Boolean(env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD);
    globalForAuth.__leadgenAdminAuthorizer = createAdminAuthorizer({
      accessConfigured,
      verify: accessConfigured
        ? createAccessVerifier({ teamDomain: env.CF_ACCESS_TEAM_DOMAIN!, audience: env.CF_ACCESS_AUD!, certsUrl: env.CF_ACCESS_CERTS_URL })
        : async () => ({ ok: false, reason: "missing" }),
      allowedEmails: env.ADMIN_ALLOWED_EMAILS,
      ownerEmails: env.ADMIN_OWNER_EMAILS,
      devEmail: env.ADMIN_DEV_EMAIL,
      // `next dev` only. `next start` always runs with NODE_ENV=production, so the bypass cannot be reached there.
      allowDevBypass: process.env.NODE_ENV === "development",
    });
  }
  return globalForAuth.__leadgenAdminAuthorizer;
}
