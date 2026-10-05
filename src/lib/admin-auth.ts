import { ACCESS_JWT_HEADER, type AccessFailure, type AccessResult } from "./cf-access";

/**
 * Decides whether a request may use the operator inbox. Pure policy over injected pieces, so every
 * branch is unit-tested without Next.js, environment variables or the network.
 *
 *   1. Development bypass (ADMIN_DEV_EMAIL): only when explicitly allowed by the caller, which wires it
 *      to NODE_ENV === "development". The environment schema already refuses the variable in staging
 *      and production; this is the second lock.
 *   2. Otherwise a valid Cloudflare Access token is required, AND its email must be on the allowlist
 *      (so a too-broad Access policy still cannot admit a stranger).
 *   3. If Access is not configured at all, nobody gets in. Fail closed.
 */
export interface AdminAuthDeps {
  /** False when CF_ACCESS_* are not set (only possible outside staging/production). */
  accessConfigured: boolean;
  verify: (token: string | null | undefined) => Promise<AccessResult>;
  allowedEmails: readonly string[];
  /** Owners are implicitly allowed in. Everyone else who is allowed is `staff`. */
  ownerEmails?: readonly string[];
  devEmail?: string | undefined;
  /** True only for `next dev`. */
  allowDevBypass: boolean;
}

export type AdminRole = "owner" | "staff";

export type AdminAuthResult =
  | { ok: true; email: string; via: "access" | "dev"; role: AdminRole }
  | { ok: false; reason: AccessFailure | "not_configured" | "not_allowed" };

export interface HeaderReader {
  get(name: string): string | null;
}

export function createAdminAuthorizer(deps: AdminAuthDeps): (headers: HeaderReader) => Promise<AdminAuthResult> {
  const owners = new Set((deps.ownerEmails ?? []).map((email) => email.toLowerCase()));
  const allowed = new Set([...deps.allowedEmails.map((email) => email.toLowerCase()), ...owners]);
  const roleOf = (email: string): AdminRole => (owners.has(email) ? "owner" : "staff");

  return async (headers) => {
    // The development bypass acts as an owner, so every screen can be tried locally.
    if (deps.allowDevBypass && deps.devEmail) return { ok: true, email: deps.devEmail.toLowerCase(), via: "dev", role: "owner" };
    if (!deps.accessConfigured) return { ok: false, reason: "not_configured" };

    const result = await deps.verify(headers.get(ACCESS_JWT_HEADER));
    if (!result.ok) return { ok: false, reason: result.reason };
    if (!allowed.has(result.email)) return { ok: false, reason: "not_allowed" };
    return { ok: true, email: result.email, via: "access", role: roleOf(result.email) };
  };
}
