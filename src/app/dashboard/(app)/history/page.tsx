import type { Metadata } from "next";
import { loadLeadList } from "@/server/client/portal";
import { LeadCards } from "../_leads";

export const metadata: Metadata = { title: "History" };

export default async function HistoryPage() {
  const { rows, more } = await loadLeadList("history");
  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">History</h1>
      <p className="mt-1 text-muted">Leads you declined, that expired, were taken back or refunded. We keep the job details; the person&rsquo;s contact details are shown only while a lead is yours.</p>
      <LeadCards rows={rows} now={new Date()} empty="Nothing here yet." />
      {more && <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950">Showing the newest {rows.length}.</p>}
    </>
  );
}
