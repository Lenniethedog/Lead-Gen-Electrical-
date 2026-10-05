"use server";

import type { Route } from "next";
import { redirect } from "next/navigation";
import { endPriceFromForm, setPriceFromForm } from "@/server/admin/pricing";

export async function setPriceAction(form: FormData): Promise<void> {
  const result = await setPriceFromForm(form);
  if (result.ok) redirect(`/admin/pricing?notice=${result.notice}` as Route);
  const detail = Object.values(result.fieldErrors ?? {})[0];
  redirect(`/admin/pricing?error=${result.error}${detail ? `&detail=${encodeURIComponent(detail)}` : ""}` as Route);
}

export async function endPriceAction(form: FormData): Promise<void> {
  const result = await endPriceFromForm(form);
  redirect((result.ok ? `/admin/pricing?notice=${result.notice}` : `/admin/pricing?error=${result.error}`) as Route);
}
