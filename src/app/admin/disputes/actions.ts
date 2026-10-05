"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { decideDisputeFromForm } from "@/server/admin/disputes";

/** A server action is reachable by a direct POST, so it authenticates inside the data layer. It answers with a redirect carrying a notice code. */
export async function decideDisputeAction(form: FormData): Promise<void> {
  const outcome = await decideDisputeFromForm(form);
  redirect((outcome.ok ? `/admin/disputes?notice=${outcome.notice}` : `/admin/disputes?error=${outcome.error}`) as Route);
}
