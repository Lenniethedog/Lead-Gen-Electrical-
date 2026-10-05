import type { Metadata } from "next";
import Link from "next/link";
import { formatPence } from "@/modules/pricing/schemas";
import { loadPerformance } from "@/server/client/portal";
import { cardClass, hintClass } from "../../../admin/_components/styles";

export const metadata: Metadata = { title: "How you are doing" };

const minutes = (value: number | null) => (value === null ? "No data yet" : value < 90 ? `${value} min` : `${Math.round((value / 60) * 10) / 10} hours`);
const percent = (part: number, whole: number) => (whole === 0 ? "-" : `${Math.round((part / whole) * 100)}%`);

export default async function PerformancePage(props: PageProps<"/dashboard/performance">) {
  const query = await props.searchParams;
  const requested = Number(Array.isArray(query.days) ? query.days[0] : query.days);
  const p = await loadPerformance([7, 30, 90].includes(requested) ? requested : 30);
  const tiles: Array<[string, string, string?]> = [
    ["Leads received", String(p.received)],
    ["Accepted", String(p.accepted), percent(p.accepted, p.received) + " of received"],
    ["Declined", String(p.declined)],
    ["Contacted", String(p.contacted), percent(p.contacted, p.accepted) + " of accepted"],
    ["Spoke to them", String(p.reached)],
    ["Quotes sent", String(p.quoted)],
    ["Jobs won", String(p.won), percent(p.won, p.accepted) + " of accepted"],
    ["Refunded", String(p.refunded)],
    ["Median time to answer", minutes(p.medianResponseMinutes), "from being told to accepting or declining"],
    ["Median time to first contact", minutes(p.medianFirstContactMinutes), "from accepting"],
  ];
  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">How you are doing</h1>
      <nav aria-label="Period" className="mt-3 flex gap-2">
        {[7, 30, 90].map((days) => (
          <Link key={days} href={`/dashboard/performance?days=${days}`} aria-current={days === p.days ? "page" : undefined} className={`rounded-lg border-2 px-4 py-2 font-semibold ${days === p.days ? "border-brand-700 bg-brand-700 text-white" : "border-stone-300 bg-white text-ink"}`}>
            Last {days} days
          </Link>
        ))}
      </nav>
      <p className={`mt-2 ${hintClass}`}>Counted from the leads sent to you in this period. The quicker you answer and ring, the more jobs you win.</p>

      <dl className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        {tiles.map(([label, value, note]) => (
          <div key={label} className={cardClass}>
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="text-2xl font-extrabold text-ink">{value}</dd>
            {note && <dd className={hintClass}>{note}</dd>}
          </div>
        ))}
      </dl>

      {!p.moneyHidden && (
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className={cardClass}><dt className="text-sm text-muted">Spent on leads</dt><dd className="text-2xl font-extrabold text-ink">{formatPence(p.spendPence)}</dd><dd className={hintClass}>Leads kept, not refunded</dd></div>
          <div className={cardClass}><dt className="text-sm text-muted">Value of jobs won</dt><dd className="text-2xl font-extrabold text-ink">{formatPence(p.wonValuePence)}</dd><dd className={hintClass}>As you recorded it</dd></div>
          <div className={cardClass}><dt className="text-sm text-muted">Spent per job won</dt><dd className="text-2xl font-extrabold text-ink">{p.won === 0 ? "-" : formatPence(Math.round(p.spendPence / p.won))}</dd></div>
        </dl>
      )}
    </>
  );
}
