import type { Metadata } from "next";
import Link from "next/link";
import { INBOX_VIEWS, type InboxView } from "@/modules/inbox";
import { loadInbox, parseView } from "@/server/admin/inbox";
import { AutoRefresh } from "../_components/AutoRefresh";
import { AlertState, StatusBadge, UrgencyBadge } from "../_components/Badges";
import { formatShort, isOverdue, waitingLabel } from "../_format";

export const metadata: Metadata = { title: "Leads" };

const VIEW_LABEL: Record<InboxView, string> = {
  open: "Needs action",
  handled: "Handled",
  assigned: "Assigned",
  screened: "Screened out",
};

const VIEW_HELP: Record<InboxView, string> = {
  open: "Held leads to approve or reject, new leads nobody has dealt with (including ones automatic routing found nobody for), and leads assigned to a business that you have not yet sent. Newest first.",
  handled: "Leads an operator has marked as handled. Newest first.",
  assigned: "Leads handed to a business, by you or by automatic routing. Open one to see who holds it and what happened. Newest first.",
  screened: "Leads the screening rejected or merged as duplicates. Check here for false positives. Newest first.",
};

const ERRORS: Record<string, string> = {
  invalid_request: "That request was not valid. Nothing was changed.",
};

export default async function LeadsPage(props: PageProps<"/admin/leads">) {
  const query = await props.searchParams;
  const { rows, total, openCount, view } = await loadInbox(parseView(query.view));
  const now = new Date();
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;

  return (
    <>
      {view === "open" && <AutoRefresh everyMs={20_000} />}
      <h1 className="text-2xl font-extrabold text-ink">Leads</h1>

      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
          {error}
        </p>
      )}

      <nav aria-label="Lead views" className="mt-4 flex flex-wrap gap-2">
        {INBOX_VIEWS.map((option) => (
          <Link
            key={option}
            href={{ pathname: "/admin/leads", query: option === "open" ? {} : { view: option } }}
            aria-current={option === view ? "page" : undefined}
            className={`rounded-lg border-2 px-4 py-2 font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300 ${
              option === view ? "border-brand-700 bg-brand-700 text-white" : "border-stone-300 bg-white text-ink hover:border-stone-500"
            }`}
          >
            {VIEW_LABEL[option]}
            {option === "open" && <span className="ml-2 rounded-full bg-white/90 px-2 text-brand-900">{openCount}</span>}
          </Link>
        ))}
      </nav>
      <p className="mt-3 text-sm text-muted">{VIEW_HELP[view]}</p>

      {rows.length === 0 ? (
        <p className="mt-8 rounded-lg border border-stone-200 bg-white px-4 py-8 text-center text-muted">
          {view === "open" ? "Nothing needs action right now." : "Nothing here yet."}
        </p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[46rem] text-left">
            <caption className="sr-only">{VIEW_LABEL[view]} leads</caption>
            <thead className="border-b border-stone-200 bg-stone-100 text-sm text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">Received</th>
                <th scope="col" className="px-4 py-3 font-semibold">Lead</th>
                <th scope="col" className="px-4 py-3 font-semibold">Job</th>
                <th scope="col" className="px-4 py-3 font-semibold">Timing</th>
                <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                <th scope="col" className="px-4 py-3 font-semibold">Alert</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200">
              {rows.map((row) => {
                const waiting = row.status === "held" || ((row.status === "new" || row.status === "unroutable") && !row.handled) || row.unsent;
                return (
                  <tr key={row.id} className={row.status === "held" || row.status === "unroutable" ? "bg-amber-50" : undefined}>
                    <td className="px-4 py-3 align-top">
                      <div className="font-semibold text-ink">{formatShort(row.receivedAt)}</div>
                      <div className={`text-sm ${waiting && isOverdue(row.receivedAt, now) ? "font-bold text-error" : "text-muted"}`}>
                        {waiting ? `waiting ${waitingLabel(row.receivedAt, now)}` : `${waitingLabel(row.receivedAt, now)} ago`}
                      </div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <Link
                        href={`/admin/leads/${row.id}`}
                        className="font-mono font-semibold text-brand-800 underline focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300"
                      >
                        {row.reference}
                      </Link>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div>{row.serviceLabel}</div>
                      <div className="text-sm text-muted">{row.postcodeOutward}</div>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <UrgencyBadge urgency={row.urgency} />
                    </td>
                    <td className="px-4 py-3 align-top">
                      <StatusBadge status={row.status} handled={row.handled} unsent={row.unsent} />
                      {row.fraudScore > 0 && <div className="mt-1 text-sm text-muted">score {row.fraudScore}</div>}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <AlertState state={row.alert} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {total > rows.length && (
        <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950">
          Showing the newest {rows.length} of {total}. The {total - rows.length} oldest are not shown
          {view === "open" ? ": open each one from its alert email, or mark old leads as handled to clear the queue." : "."}
        </p>
      )}
      <p className="mt-6 text-sm text-muted">Contact details are shown on a lead&rsquo;s own page, never in this list.</p>
    </>
  );
}
