"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { acceptLeadFromForm, declineLeadFromForm, logContactFromForm, type AnswerOutcome } from "@/server/client/portal";

/** Server actions are reachable by a direct POST, so each authenticates inside the data layer. They answer with a redirect carrying a short notice code. */
const where = (outcome: AnswerOutcome): Route => {
  if (!outcome.ok) return (outcome.assignmentId ? `/dashboard/leads/${outcome.assignmentId}?error=${outcome.error}#respond` : "/dashboard") as Route;
  // A declined lead is no longer theirs to look at: back to the list.
  return (outcome.notice === "declined" ? "/dashboard?notice=declined" : `/dashboard/leads/${outcome.assignmentId}?notice=${outcome.notice}`) as Route;
};

export async function acceptAction(form: FormData): Promise<void> {
  redirect(where(await acceptLeadFromForm(form)));
}
export async function declineAction(form: FormData): Promise<void> {
  redirect(where(await declineLeadFromForm(form)));
}
export async function logContactAction(form: FormData): Promise<void> {
  redirect(where(await logContactFromForm(form)));
}
