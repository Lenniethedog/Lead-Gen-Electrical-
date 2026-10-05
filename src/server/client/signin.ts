import "server-only";
import { headers } from "next/headers";
import { resolveClientIp } from "@/lib/ip";
import { getContainer } from "../container";
import { clearSessionCookie, newRequestId, readSessionCookie, setSessionCookie } from "./session";

/**
 * The pages that happen BEFORE there is a session: asking for a link, spending it, signing out. These are the only dashboard
 * functions that do not require a session (they are how you get one). Nothing here returns anything about whether an address exists.
 */

export type RequestLinkOutcome = { ok: true } | { ok: false; error: "invalid_request" | "slow_down" };

export async function askForSignInLink(form: FormData): Promise<RequestLinkOutcome> {
  const container = getContainer();
  const email = form.get("email");
  if (typeof email !== "string" || email.length > 254) return { ok: false, error: "invalid_request" };
  const ip = resolveClientIp(await headers(), container.signIn.ipConfig);
  if (ip !== null && !container.signIn.rateLimiter.check(ip).allowed) return { ok: false, error: "slow_down" };
  await container.clientAuth.requestLink({ email, requestId: newRequestId() });
  // The same answer whether or not the address has an account.
  return { ok: true };
}

export type CompleteSignInOutcome = { ok: true } | { ok: false };

export async function completeSignIn(form: FormData): Promise<CompleteSignInOutcome> {
  const container = getContainer();
  const ip = resolveClientIp(await headers(), container.signIn.ipConfig);
  if (ip !== null && !container.signIn.rateLimiter.check(ip).allowed) return { ok: false };
  const result = await container.clientAuth.redeem({ token: form.get("token") });
  if (!result.ok) return { ok: false };
  await setSessionCookie(result.sessionToken, result.expiresAt);
  return { ok: true };
}

export async function signOutOfDashboard(): Promise<void> {
  await getContainer().clientAuth.signOut(await readSessionCookie());
  await clearSessionCookie();
}
