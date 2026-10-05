"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { moveRuleFromForm, saveMaxAgeFromForm, saveRuleFromForm, setRoutingEnabledFromForm, type RoutingOutcome } from "@/server/admin/routing";

/** Server actions are reachable by a direct POST, so each authenticates (and checks the owner role) inside the data layer. They answer with a redirect carrying a short notice code. */
const back = (result: RoutingOutcome): Route =>
  (result.ok
    ? `/admin/routing?notice=${result.notice}`
    : `/admin/routing?error=${result.error}${result.detail ? `&detail=${encodeURIComponent(result.detail)}` : ""}`) as Route;

export async function setRoutingEnabledAction(form: FormData): Promise<void> {
  redirect(back(await setRoutingEnabledFromForm(form)));
}
export async function saveMaxAgeAction(form: FormData): Promise<void> {
  redirect(back(await saveMaxAgeFromForm(form)));
}
export async function saveRuleAction(form: FormData): Promise<void> {
  redirect(back(await saveRuleFromForm(form)));
}
export async function moveRuleAction(form: FormData): Promise<void> {
  redirect(back(await moveRuleFromForm(form)));
}
