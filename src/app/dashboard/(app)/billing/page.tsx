import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatShort } from "@/app/admin/_format";
import { BILLING_MODES, LEDGER_TYPE_LABELS } from "@/config/billing";
import { formatPence } from "@/modules/pricing/schemas";
import { loadBillingForBusiness } from "@/server/client/portal";
import { cardClass, hintClass } from "../../../admin/_components/styles";

export const metadata: Metadata = { title: "Billing" };

const signed = (pence: number) => `${pence < 0 ? "-" : "+"}${formatPence(Math.abs(pence))}`;

export default async function BillingPage() {
  const billing = await loadBillingForBusiness();
  if (!billing) notFound();
  const prepaid = billing.mode === "prepaid";
  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Billing</h1>
      <p className="mt-1 text-muted">{BILLING_MODES[billing.mode]}.</p>

      <section aria-labelledby="summary-heading" className={`${cardClass} mt-4`}>
        <h2 id="summary-heading" className="sr-only">Summary</h2>
        <dl className="grid gap-4 sm:grid-cols-2">
          {prepaid && (
            <div>
              <dt className="text-sm text-muted">Credit remaining</dt>
              <dd className="text-3xl font-extrabold text-ink">{formatPence(billing.balancePence)}</dd>
              <dd className={hintClass}>Each new lead is taken from your credit. With too little, new leads go to another business. To add credit, contact us (payment by bank transfer for now).</dd>
            </div>
          )}
          <div>
            <dt className="text-sm text-muted">Charged this month</dt>
            <dd className="text-3xl font-extrabold text-ink">{formatPence(billing.thisMonth.totalPence)}</dd>
            <dd className={hintClass}>{billing.thisMonth.leads} lead{billing.thisMonth.leads === 1 ? "" : "s"}{prepaid ? "" : ". You will be invoiced for these."}. A lead you decline, or that is taken back, is not charged.</dd>
          </div>
        </dl>
      </section>

      {prepaid && (
        <section aria-labelledby="ledger-heading" className={`${cardClass} mt-4`}>
          <h2 id="ledger-heading" className="text-xl font-bold text-ink">Credit history</h2>
          {billing.ledger.length === 0 ? <p className="mt-1">Nothing yet.</p> : (
            <div tabIndex={0} role="region" aria-label="Credit history" className="relative mt-2 overflow-x-auto focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
              <table className="w-full min-w-[30rem] text-left text-sm">
                <caption className="sr-only">Credit history, newest first</caption>
                <thead className="text-muted"><tr><th scope="col" className="py-2 pr-3">When</th><th scope="col" className="py-2 pr-3">What</th><th scope="col" className="py-2 pr-3">Lead</th><th scope="col" className="py-2 pr-3 text-right">Amount</th><th scope="col" className="py-2 text-right">Balance</th></tr></thead>
                <tbody className="divide-y divide-stone-200">
                  {billing.ledger.map((entry) => (
                    <tr key={entry.id}>
                      <td className="py-2 pr-3">{formatShort(entry.at)}</td>
                      <td className="py-2 pr-3">{LEDGER_TYPE_LABELS[entry.type]}</td>
                      <td className="py-2 pr-3 font-mono">{entry.reference ?? ""}</td>
                      <td className="py-2 pr-3 text-right font-semibold">{signed(entry.amountPence)}</td>
                      <td className="py-2 text-right">{formatPence(entry.balanceAfterPence)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="charges-heading" className={`${cardClass} mt-4`}>
        <h2 id="charges-heading" className="text-xl font-bold text-ink">Leads charged</h2>
        {billing.charges.length === 0 ? <p className="mt-1">No leads have been charged yet.</p> : (
          <div tabIndex={0} role="region" aria-label="Leads charged" className="relative mt-2 overflow-x-auto focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
            <table className="w-full min-w-[26rem] text-left text-sm">
              <caption className="sr-only">Leads charged, newest first</caption>
              <thead className="text-muted"><tr><th scope="col" className="py-2 pr-3">When</th><th scope="col" className="py-2 pr-3">Lead</th><th scope="col" className="py-2 pr-3 text-right">Amount</th><th scope="col" className="py-2">State</th></tr></thead>
              <tbody className="divide-y divide-stone-200">
                {billing.charges.map((charge) => (
                  <tr key={charge.id}>
                    <td className="py-2 pr-3">{formatShort(charge.at)}</td>
                    <td className="py-2 pr-3 font-mono">{charge.reference}</td>
                    <td className="py-2 pr-3 text-right font-semibold">{formatPence(charge.amountPence)}</td>
                    <td className="py-2">{charge.status === "posted" ? "Charged" : "Refunded"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
