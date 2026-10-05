"use server";

import { redirect } from "next/navigation";
import { completeSignIn } from "@/server/client/signin";

export async function completeSignInAction(form: FormData): Promise<void> {
  const outcome = await completeSignIn(form);
  redirect(outcome.ok ? "/dashboard" : "/dashboard/login?error=link");
}
