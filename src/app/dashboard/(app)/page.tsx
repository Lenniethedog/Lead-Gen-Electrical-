import type { Metadata } from "next";
import { AutoRefresh } from "@/app/admin/_components/AutoRefresh";
import { loadLeadList } from "@/server/client/portal";
import { LeadCards } from "./_leads";

export const metadata: Metadata = { title: "New leads" };

export default async function NewLeadsPage() {
  const { rows, more } = await loadLeadList("open");
  return (
    <>
      <AutoRefresh everyMs={30_000} />
      <h1 className="text-2xl font-extrabold text-ink">New leads</h1>
      <p className="mt-1 text-muted">Leads sent only to you. The sooner you ring, the better your chance of the job. Newest first.</p>
      <LeadCards rows={rows} now={new Date()} empty="No new leads right now. We will text or email you the moment one arrives." />
      {more && <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950">Showing the newest {rows.length}. Older ones are in History once you have dealt with them.</p>}
    </>
  );
}
