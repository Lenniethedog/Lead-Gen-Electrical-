"use server";

import { redirect } from "next/navigation";
import { signOutOfDashboard } from "@/server/client/signin";

export async function signOutAction(): Promise<void> {
  await signOutOfDashboard();
  redirect("/dashboard/login");
}
