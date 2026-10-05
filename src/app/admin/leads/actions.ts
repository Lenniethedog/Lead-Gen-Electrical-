"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import {
  assignLeadFromForm,
  cancelAssignmentFromForm,
  eraseLeadFromForm,
  markSentFromForm,
  reassignFromForm,
  withdrawConsentFromForm,
  type WorkOutcome,
} from "@/server/admin/assignments";
import { decideHeldLead, markLeadHandled, type ActionOutcome } from "@/server/admin/inbox";

/**
 * Server actions are reachable by a direct POST, so each one authenticates inside the data layer
 * (requireOperator) rather than trusting that the page that rendered the form did.
 * They answer with a redirect carrying a short notice code: works without JavaScript, and a
 * browser refresh cannot resubmit the decision.
 */
function destination(outcome: ActionOutcome): Route {
  // The pieces are a validated uuid and fixed codes, so the string is safe to treat as a route.
  if (outcome.ok) return `/admin/leads/${outcome.leadId}?notice=${outcome.notice}` as Route;
  if (outcome.leadId) return `/admin/leads/${outcome.leadId}?error=${outcome.error}` as Route;
  return `/admin/leads?error=${outcome.error}` as Route;
}

export async function decideLeadAction(form: FormData): Promise<void> {
  redirect(destination(await decideHeldLead(form)));
}

export async function handleLeadAction(form: FormData): Promise<void> {
  redirect(destination(await markLeadHandled(form)));
}

/** Handing leads to businesses and the privacy actions (stage 3): same pattern, with the reasons a coverage refusal names. */
function workDestination(outcome: WorkOutcome): Route {
  if (!outcome.ok && !outcome.leadId) return `/admin/leads?error=${outcome.error}` as Route;
  const id = outcome.leadId;
  if (outcome.ok) return `/admin/leads/${id}?notice=${outcome.notice}` as Route;
  const why = outcome.reasons && outcome.reasons.length > 0 ? `&why=${outcome.reasons.join(",")}` : "";
  return `/admin/leads/${id}?error=${outcome.error}${why}` as Route;
}

export async function assignLeadAction(form: FormData): Promise<void> {
  redirect(workDestination(await assignLeadFromForm(form)));
}
export async function markSentAction(form: FormData): Promise<void> {
  redirect(workDestination(await markSentFromForm(form)));
}
export async function cancelAssignmentAction(form: FormData): Promise<void> {
  redirect(workDestination(await cancelAssignmentFromForm(form)));
}
export async function reassignAction(form: FormData): Promise<void> {
  redirect(workDestination(await reassignFromForm(form)));
}
export async function withdrawConsentAction(form: FormData): Promise<void> {
  redirect(workDestination(await withdrawConsentFromForm(form)));
}
export async function eraseLeadAction(form: FormData): Promise<void> {
  redirect(workDestination(await eraseLeadFromForm(form)));
}
