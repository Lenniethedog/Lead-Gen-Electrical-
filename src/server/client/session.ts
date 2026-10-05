import "server-only";
import { randomUUID } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ClientSession } from "@/modules/clientauth";
import { getContainer } from "../container";

/**
 * Who is signed in, for the business dashboard (stage 6, D43). Implements the cookie; the rules about WHEN a session is good live in
 * `modules/clientauth` and are checked against the database on every call. This file and `signin.ts` are the only places that touch
 * the cookie; every other dashboard function gets the verified `ClientSession` from `requireClientSession`.
 */
const COOKIE = { name: "lg_client", secureName: "__Host-lg_client" } as const;
const cookieName = () => (getContainer().signIn.secureCookies ? COOKIE.secureName : COOKIE.name);

/** The signed-in person or undefined. Cached per request, so a page and its layout cost one lookup. */
export const optionalClientSession = cache(async (): Promise<ClientSession | undefined> => {
  const jar = await cookies();
  return getContainer().clientAuth.resolve(jar.get(cookieName())?.value);
});

/** Every dashboard page, layout and server action starts here. Not signed in means the sign-in page, never a half-rendered one. */
export async function requireClientSession(): Promise<ClientSession> {
  const session = await optionalClientSession();
  if (!session) redirect("/dashboard/login");
  return session;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(cookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: getContainer().signIn.secureCookies,
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(cookieName());
}

export async function readSessionCookie(): Promise<string | undefined> {
  return (await cookies()).get(cookieName())?.value;
}

export const newRequestId = (): string => `web-${randomUUID().slice(0, 12)}`;
