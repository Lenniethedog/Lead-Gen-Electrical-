"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { requestChangeFromForm } from "@/server/client/portal";

export async function requestChangeAction(form: FormData): Promise<void> {
  const outcome = await requestChangeFromForm(form);
  redirect((outcome.ok ? "/dashboard/areas?notice=requested#requests" : `/dashboard/areas?error=${outcome.error}#requests`) as Route);
}
