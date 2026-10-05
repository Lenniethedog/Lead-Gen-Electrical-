"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { retryDeliveryFromForm } from "@/server/admin/delivery";

/** Reachable by a direct POST, so it authenticates inside the data layer. Answers with a redirect carrying a short notice code. */
export async function retryDeliveryAction(form: FormData): Promise<void> {
  const result = await retryDeliveryFromForm(form);
  const query = result.ok ? "notice=delivery_retried" : `error=${result.error}`;
  redirect((form.get("returnTo") === "lead" && result.leadId ? `/admin/leads/${result.leadId}?${query}#delivery` : `/admin/deliveries?${query}`) as Route);
}
