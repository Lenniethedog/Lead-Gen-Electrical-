import Link from "next/link";
import { waitingLabel } from "@/app/admin/_format";
import type { LeadRow } from "@/modules/portal";
import { LeadStatusBadge, TimingBadge } from "../_components/StatusBadge";

/** One card per lead: a phone-first list, since most owners will open this from a text or email on site. */
export function LeadCards({ rows, now, empty }: { rows: LeadRow[]; now: Date; empty: string }) {
  if (rows.length === 0) {
    return <p className="mt-6 rounded-lg border border-stone-200 bg-white px-4 py-8 text-center text-muted">{empty}</p>;
  }
  return (
    <ul className="mt-4 space-y-3">
      {rows.map((row) => (
        <li key={row.assignmentId}>
          <Link
            href={`/dashboard/leads/${row.assignmentId}`}
            className="block rounded-lg border border-stone-200 bg-white p-4 hover:border-stone-400 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-lg font-bold text-ink">{row.serviceLabel}</span>
              <span className="flex flex-wrap gap-2">
                <TimingBadge urgency={row.urgency} />
                <LeadStatusBadge status={row.status} />
              </span>
            </div>
            <div className="mt-1 text-muted">
              {row.district} · <span className="font-mono">{row.reference}</span> · {waitingLabel(row.assignedAt, now)} ago
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
