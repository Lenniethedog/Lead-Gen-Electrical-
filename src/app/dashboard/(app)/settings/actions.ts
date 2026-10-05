"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { saveNotificationSettingsFromForm } from "@/server/client/portal";

export async function saveSettingsAction(form: FormData): Promise<void> {
  const outcome = await saveNotificationSettingsFromForm(form);
  redirect((outcome.ok ? "/dashboard/settings?notice=saved" : `/dashboard/settings?error=${outcome.error}`) as Route);
}
