import { REASON_TEXT } from "@/modules/coverage/reasons";
import { formatPence } from "@/modules/pricing/schemas";
import { EXCLUSION_TEXT, type ExclusionCode } from "@/modules/routing/engine";
import { RUN_REASON_TEXT } from "@/modules/routing/blockers";
import type { RunDetail } from "@/modules/routing";
import { hintClass } from "./styles";

type RunOutcome = "assigned" | "no_candidates" | "error" | "skipped";

const OUTCOME: Record<RunOutcome, { text: string; className: string }> = {
  assigned: { text: "Assigned", className: "bg-green-100 text-green-900" },
  no_candidates: { text: "Nobody could take it", className: "bg-amber-100 text-amber-900" },
  skipped: { text: "Left alone", className: "bg-stone-200 text-stone-800" },
  error: { text: "Error", className: "bg-red-100 text-red-900" },
};

export function RunOutcomeBadge({ outcome }: { outcome: RunOutcome }) {
  const { text, className } = OUTCOME[outcome];
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-sm font-semibold ${className}`}>{text}</span>;
}

export const runReasonText = (code: string | null): string | undefined => (code ? (RUN_REASON_TEXT[code] ?? code) : undefined);

/**
 * Every business that covers the lead, with the verdict, the reasons and the numbers behind the ranking; and, folded away, the businesses
 * that do not cover it. Used for a stored run (what the router DID) and for the live dry run (what it WOULD do): the same shape.
 */
export function RoutingVerdicts({ detail, caption }: { detail: RunDetail; caption: string }) {
  const rows = [...detail.clients].sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || a.name.localeCompare(b.name));
  return (
    <div className="mt-3 space-y-3">
      <p className={hintClass}>
        {detail.coverage.covered} of {detail.coverage.clients} business{detail.coverage.clients === 1 ? "" : "es"} cover this lead.{" "}
        {detail.price ? <>Price: <strong>{formatPence(detail.price.pence)}</strong>.</> : <strong>No price rule matches this lead.</strong>}
      </p>
      {rows.length > 0 && (
        // Scrolls sideways on a phone and holds nothing focusable, so a keyboard user needs to be able to reach it to scroll it.
        <div className="overflow-x-auto rounded-lg border border-stone-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300" tabIndex={0} role="region" aria-label={caption}>
          <table className="w-full min-w-[34rem] text-left text-sm">
            <caption className="sr-only">{caption}</caption>
            <thead className="border-b border-stone-200 bg-stone-100 text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">Business</th>
                <th scope="col" className="px-3 py-2 font-semibold">Result</th>
                <th scope="col" className="px-3 py-2 font-semibold">Why</th>
                <th scope="col" className="px-3 py-2 font-semibold">Priority</th>
                <th scope="col" className="px-3 py-2 font-semibold">Fair share</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200">
              {rows.map((row) => (
                <tr key={row.clientId} className={row.result === "chosen" ? "bg-green-50" : undefined}>
                  <th scope="row" className="px-3 py-2 font-semibold text-ink">{row.name}</th>
                  <td className="px-3 py-2">
                    {row.result === "chosen" ? <strong>Chosen</strong> : row.eligible ? (row.result === "changed_while_routing" ? "Passed over (changed while deciding)" : `Next in line (${row.rank})`) : "Not eligible"}
                  </td>
                  <td className="px-3 py-2">
                    {row.eligible ? "Passed every check" : (
                      <ul className="space-y-0.5">
                        {row.excludedBy.map((code: ExclusionCode) => <li key={code}>{EXCLUSION_TEXT[code]}{code === "daily_cap_reached" && row.detail.dailyCap !== undefined ? ` (${row.detail.assignedToday} of ${row.detail.dailyCap})` : ""}{code === "monthly_cap_reached" && row.detail.monthlyCap !== undefined ? ` (${row.detail.assignedThisMonth} of ${row.detail.monthlyCap})` : ""}</li>)}
                      </ul>
                    )}
                  </td>
                  <td className="px-3 py-2">{row.keys ? row.keys.priority : "–"}</td>
                  <td className="px-3 py-2">{row.keys ? row.keys.fairness : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {detail.notCovered.length > 0 && (
        <details>
          <summary className="cursor-pointer font-semibold text-ink">Businesses that do not cover this lead ({detail.notCovered.length})</summary>
          <ul className="mt-2 space-y-1 text-sm">
            {detail.notCovered.map((client) => (
              <li key={client.clientId}>
                <strong>{client.name}</strong>: {client.reasons.map((reason) => REASON_TEXT[reason]).join("; ")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
