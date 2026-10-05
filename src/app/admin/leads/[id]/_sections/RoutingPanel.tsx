import Link from "next/link";
import { BLOCKER_TEXT } from "@/modules/routing/blockers";
import type { Explanation, RunDetail, StoredRun } from "@/modules/routing";
import { formatShort } from "../../../_format";
import { RoutingVerdicts, RunOutcomeBadge, runReasonText } from "../../../_components/RoutingParts";
import { cardClass, hintClass, linkClass } from "../../../_components/styles";

interface Props {
  leadId: string;
  runs: StoredRun[];
  /** Present when the operator asked "who would get this lead right now?". */
  explanation: Explanation | undefined;
  /** Whether asking makes sense (the lead is not closed, erased or already settled). */
  canExplain: boolean;
}

/**
 * Why the lead went where it did (what the router recorded), and, on request, who would get it if the router looked now. The second is a
 * read-only dry run of the same decision code, so it cannot disagree with what routing really does.
 */
export function RoutingPanel({ leadId, runs, explanation, canExplain }: Props) {
  if (runs.length === 0 && !explanation && !canExplain) return null;
  const latest = runs[0];
  const latestDetail = latest?.candidates as Partial<RunDetail> | undefined;

  return (
    <section id="routing" aria-labelledby="routing-heading" className={`${cardClass} mt-6`}>
      <h2 id="routing-heading" className="text-xl font-bold text-ink">Routing</h2>

      {latest ? (
        <div className="mt-2">
          <p className="flex flex-wrap items-center gap-2">
            <RunOutcomeBadge outcome={latest.outcome} />
            <span>
              {latest.outcome === "assigned" ? <>The router chose <strong>{latest.chosenClientName}</strong>.</> : (runReasonText(latest.error) ?? "Nothing was assigned.")}
            </span>
            <span className={hintClass}>{formatShort(latest.createdAt)}{latest.durationMs !== null ? `, ${latest.durationMs} ms` : ""}</span>
          </p>
          {latestDetail?.clients && latestDetail.coverage && latestDetail.notCovered && (
            <details className="mt-2" open={latest.outcome !== "assigned"}>
              <summary className="cursor-pointer font-semibold text-ink">Why this result</summary>
              <RoutingVerdicts detail={latestDetail as RunDetail} caption="The router's verdict for every business that covers this lead" />
            </details>
          )}
          {runs.length > 1 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-sm font-semibold text-muted">Earlier attempts ({runs.length - 1})</summary>
              <ul className="mt-2 space-y-1 text-sm">
                {runs.slice(1).map((run) => (
                  <li key={run.id}>
                    {formatShort(run.createdAt)} · <RunOutcomeBadge outcome={run.outcome} /> {run.chosenClientName ? `to ${run.chosenClientName}` : (runReasonText(run.error) ?? "")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : (
        <p className="mt-2 text-muted">The router has not looked at this lead.</p>
      )}

      {explanation ? (
        <div className="mt-4 rounded-lg border-2 border-brand-300 bg-brand-50 p-4">
          <h3 className="text-lg font-bold text-ink">If the router looked at it now</h3>
          {explanation.blockers.length > 0 ? (
            <div className="mt-1">
              <p className="font-semibold">It would leave this lead alone:</p>
              <ul className="list-disc pl-6">
                {explanation.blockers.map((blocker) => <li key={blocker}>{BLOCKER_TEXT[blocker]}</li>)}
              </ul>
              {explanation.analysis && <p className={`mt-1 ${hintClass}`}>For information, this is who it would choose otherwise:</p>}
            </div>
          ) : (
            <p className="mt-1">It would take this lead.</p>
          )}
          {explanation.analysis ? (
            <>
              <p className="mt-2">
                {explanation.analysis.chosenClientId
                  ? <>First in line: <strong>{explanation.analysis.detail.clients.find((client) => client.clientId === explanation.analysis!.chosenClientId)?.name}</strong>.</>
                  : <strong>Nobody could take it.</strong>}
              </p>
              <RoutingVerdicts detail={explanation.analysis.detail} caption="Who would get this lead if the router looked at it now" />
            </>
          ) : (
            <p className="mt-2 text-muted">Nothing to decide: this lead&rsquo;s details are gone.</p>
          )}
          <p className="mt-3">
            <Link href={`/admin/leads/${leadId}#routing`} className={linkClass}>Hide this</Link>
          </p>
        </div>
      ) : (
        canExplain && (
          <p className="mt-4">
            <Link href={`/admin/leads/${leadId}?explain=routing#routing`} className={linkClass}>Who would get this lead if the router looked at it now?</Link>
          </p>
        )
      )}
    </section>
  );
}
