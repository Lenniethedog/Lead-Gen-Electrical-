"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import type { FormState } from "@/modules/clients";
import type { SecretState } from "./[id]/secret-state";
import {
  addClientCoverage,
  addClientPause,
  changeClientServices,
  changeClientStatus,
  createClientFromForm,
  removeClientCoverage,
  removeClientPause,
  rotateClientWebhookSecret,
  saveClientDelivery,
  saveClientRoutingPreferences,
  saveClientWorkingHours,
  updateClientFromForm,
  type ClientOutcome,
} from "@/server/admin/clients";
import { inviteClientUser, resendClientUserLink, setClientUserDisabled, setClientUserRole, type UserOutcome } from "@/server/admin/users";

/**
 * Server actions are reachable by a direct POST, so each authenticates inside the data layer (requireOperator).
 * They answer with a redirect carrying a short notice code: it works without JavaScript, and a refresh cannot resubmit.
 */
const detail = (clientId: string | undefined, query: string): Route => (clientId ? `/admin/clients/${clientId}?${query}` : `/admin/clients?${query}`) as Route;
const outcome = (result: ClientOutcome): Route => (result.ok ? detail(result.clientId, `notice=${result.notice}`) : detail(result.clientId, `error=${result.error}`));

const userOutcome = (result: UserOutcome): Route => ((result.ok ? detail(result.clientId, `notice=${result.notice}`) : detail(result.clientId, `error=${result.error}`)) + "#people") as Route;

export async function inviteUserAction(form: FormData): Promise<void> {
  redirect(userOutcome(await inviteClientUser(form)));
}
export async function resendUserLinkAction(form: FormData): Promise<void> {
  redirect(userOutcome(await resendClientUserLink(form)));
}
export async function setUserDisabledAction(form: FormData): Promise<void> {
  redirect(userOutcome(await setClientUserDisabled(form)));
}
export async function setUserRoleAction(form: FormData): Promise<void> {
  redirect(userOutcome(await setClientUserRole(form)));
}

export async function createClientAction(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await createClientFromForm(form);
  if (!result.ok) return result.state;
  redirect(detail(result.clientId, "notice=created"));
}

export async function updateClientAction(clientId: string, _previous: FormState, form: FormData): Promise<FormState> {
  const result = await updateClientFromForm(clientId, form);
  if (!result.ok) return result.state;
  redirect(detail(clientId, "notice=saved"));
}

export async function changeStatusAction(form: FormData): Promise<void> {
  redirect(outcome(await changeClientStatus(form)));
}

export async function changeServicesAction(form: FormData): Promise<void> {
  redirect(outcome(await changeClientServices(form)));
}

export async function addCoverageAction(form: FormData): Promise<void> {
  const result = await addClientCoverage(form);
  // A malformed rule names the field; surface the first message instead of a generic error.
  const field = result.ok ? undefined : Object.entries(result.fieldErrors ?? {})[0];
  redirect(field ? detail(result.ok ? undefined : result.clientId, `error=invalid_request&detail=${encodeURIComponent(field[1])}`) : outcome(result));
}

export async function removeCoverageAction(form: FormData): Promise<void> {
  redirect(outcome(await removeClientCoverage(form)));
}

/** Routing preferences, hours and pauses: a field problem is shown in the page's alert (the first one, in plain words). */
const withFieldProblem = (result: Awaited<ReturnType<typeof saveClientRoutingPreferences>>): Route => {
  const problem = result.ok ? undefined : Object.values(result.fieldErrors ?? {})[0];
  return problem ? detail(result.clientId, `error=invalid_request&detail=${encodeURIComponent(problem)}#routing`) : (`${outcome(result)}#routing` as Route);
};

export async function saveRoutingPreferencesAction(form: FormData): Promise<void> {
  redirect(withFieldProblem(await saveClientRoutingPreferences(form)));
}

export async function saveWorkingHoursAction(form: FormData): Promise<void> {
  redirect(withFieldProblem(await saveClientWorkingHours(form)));
}

export async function addPauseAction(form: FormData): Promise<void> {
  redirect(withFieldProblem(await addClientPause(form)));
}

export async function removePauseAction(form: FormData): Promise<void> {
  redirect(`${outcome(await removeClientPause(form))}#routing` as Route);
}

export async function saveDeliveryAction(form: FormData): Promise<void> {
  redirect(withFieldProblem(await saveClientDelivery(form)).replace("#routing", "#delivery") as Route);
}

/** Returns the new secret to the page that asked (never a redirect: a secret in a URL would end up in logs and history). Shown once. */
export async function rotateSecretAction(_previous: SecretState, form: FormData): Promise<SecretState> {
  const result = await rotateClientWebhookSecret(form);
  return result.ok ? { secret: result.secret } : { error: result.error };
}
