import { redirect } from "next/navigation";
import { loadOperatorEmail } from "@/server/admin/inbox";

export default async function AdminHome() {
  await loadOperatorEmail(); // authenticate before doing anything, even a redirect
  redirect("/admin/leads");
}
