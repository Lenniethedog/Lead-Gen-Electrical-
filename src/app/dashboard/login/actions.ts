"use server";

import { redirect } from "next/navigation";
import { askForSignInLink } from "@/server/client/signin";

/** Answers with a redirect (works without JavaScript; a refresh cannot resend). The address is never put in the URL. */
export async function requestLinkAction(form: FormData): Promise<void> {
  const outcome = await askForSignInLink(form);
  redirect(outcome.ok ? "/dashboard/login?sent=1" : `/dashboard/login?error=${outcome.error}`);
}
