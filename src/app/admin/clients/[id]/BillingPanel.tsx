import { BILLING_MODES, BILLING_MODE_CODES, CREDIT_KINDS, LEDGER_TYPE_LABELS } from "@/config/billing";
import type { BillingOverview } from "@/modules/billing";
import { formatPence } from "@/modules/pricing/schemas";
import { cardClass, hintClass, inputClass, labelClass, primaryButton, secondaryButton } from "../../_components/styles";
import { formatShort } from "../../_format";
import { changeBillingModeAction, postCreditAction } from "../actions";

const signed = (pence: number) => `${pence < 0 ? "-" : "+"}${formatPence(Math.abs(pence))}`;

/** What a business pays, and its credit. Staff add credit here when payment arrives (until payments are built) and correct mistakes; nothing else moves money by hand. */
export function BillingPanel({ clientId, billing }: { clientId: string; billing: BillingOverview }) {
  const postingId = crypto.randomUUID(); // one per page render: pressing the button twice cannot post twice
  return (
    <section id="billing" aria-labelledby="billing-heading" className={`${cardClass} mt-6`}>
      <h2 id="billing-heading" className="text-xl font-bold text-ink">Billing and credit</h2>
      <p className={`mt-1 max-w-3xl ${hintClass}`}>
        <strong>Invoiced</strong>: every lead is recorded as a charge and you invoice from the list below; nothing is taken from credit. <strong>Prepaid</strong>: each lead is paid for from credit the moment it is assigned, a business with too little credit is never given a lead, and a lead that ends without being kept
        is refunded automatically.
      </p>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <form action={changeBillingModeAction} className="space-y-2">
          <input type="hidden" name="clientId" value={clientId} />
          <label htmlFor="billingMode" className={labelClass}>How they pay</label>
          <select id="billingMode" name="billingMode" defaultValue={billing.mode} className={inputClass}>
            {BILLING_MODE_CODES.map((mode) => <option key={mode} value={mode}>{mode === "invoice" ? "Invoiced" : "Prepaid from credit"}</option>)}
          </select>
          <p className={hintClass}>{BILLING_MODES[billing.mode]}. Changing it affects leads assigned from now on.</p>
          <button type="submit" className={secondaryButton}>Save</button>
        </form>

        <div>
          <p className="text-sm text-muted">Credit balance</p>
          <p className="text-3xl font-extrabold text-ink" aria-label="Credit balance">{formatPence(billing.balancePence)}</p>
          <p className={hintClass}>This month: {billing.thisMonth.leads} lead{billing.thisMonth.leads === 1 ? "" : "s"} charged, {formatPence(billing.thisMonth.totalPence)}.</p>
        </div>
      </div>

      <h3 className="mt-6 text-lg font-bold text-ink">Add or correct credit</h3>
      <form action={postCreditAction} className="mt-2 grid gap-3 sm:grid-cols-3">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="postingId" value={postingId} />
        <div>
          <label htmlFor="credit-entry" className={labelClass}>What for</label>
          <select id="credit-entry" name="entry" required defaultValue="" className={inputClass}>
            <option value="" disabled>Choose</option>
            {(Object.keys(CREDIT_KINDS) as Array<keyof typeof CREDIT_KINDS>).map((kind) => (
              <optgroup key={kind} label={CREDIT_KINDS[kind].label}>
                {Object.entries(CREDIT_KINDS[kind].reasons).map(([reason, label]) => <option key={reason} value={`${kind}:${reason}`}>{label}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="credit-amount" className={labelClass}>Amount (£)</label>
          <input id="credit-amount" name="amount" inputMode="decimal" autoComplete="off" required placeholder="250" aria-describedby="credit-hint" className={inputClass} />
          <p id="credit-hint" className={hintClass}>A correction can be negative, like -40.</p>
        </div>
        <div className="flex items-end"><button type="submit" className={primaryButton}>Record it</button></div>
      </form>

      <h3 className="mt-6 text-lg font-bold text-ink">Credit ledger</h3>
      {billing.ledger.length === 0 ? <p className="mt-1">Nothing yet.</p> : (
        <div tabIndex={0} role="region" aria-label="Credit ledger" className="relative mt-2 overflow-x-auto rounded-lg border border-stone-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Credit ledger, newest first</caption>
            <thead className="bg-stone-100 text-muted"><tr><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">What</th><th scope="col" className="px-3 py-2">Lead</th><th scope="col" className="px-3 py-2 text-right">Amount</th><th scope="col" className="px-3 py-2 text-right">Balance</th><th scope="col" className="px-3 py-2">By</th></tr></thead>
            <tbody className="divide-y divide-stone-200">
              {billing.ledger.map((entry) => (
                <tr key={entry.id}>
                  <td className="px-3 py-2">{formatShort(entry.at)}</td>
                  <td className="px-3 py-2">{LEDGER_TYPE_LABELS[entry.type]}{entry.reason ? <span className="text-muted"> ({entry.reason.replace(/_/g, " ")})</span> : null}</td>
                  <td className="px-3 py-2 font-mono">{entry.reference ?? ""}</td>
                  <td className="px-3 py-2 text-right font-semibold">{signed(entry.amountPence)}</td>
                  <td className="px-3 py-2 text-right">{formatPence(entry.balanceAfterPence)}</td>
                  <td className="px-3 py-2">{entry.by ?? "system"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h3 className="mt-6 text-lg font-bold text-ink">Charges (to invoice from)</h3>
      {billing.charges.length === 0 ? <p className="mt-1">No leads have been charged yet.</p> : (
        <div tabIndex={0} role="region" aria-label="Lead charges" className="relative mt-2 overflow-x-auto rounded-lg border border-stone-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
          <table className="w-full min-w-[32rem] text-left text-sm">
            <caption className="sr-only">Lead charges, newest first</caption>
            <thead className="bg-stone-100 text-muted"><tr><th scope="col" className="px-3 py-2">When</th><th scope="col" className="px-3 py-2">Lead</th><th scope="col" className="px-3 py-2 text-right">Amount</th><th scope="col" className="px-3 py-2">Paid from</th><th scope="col" className="px-3 py-2">State</th></tr></thead>
            <tbody className="divide-y divide-stone-200">
              {billing.charges.map((charge) => (
                <tr key={charge.id}>
                  <td className="px-3 py-2">{formatShort(charge.at)}</td>
                  <td className="px-3 py-2 font-mono">{charge.reference}</td>
                  <td className="px-3 py-2 text-right font-semibold">{formatPence(charge.amountPence)}</td>
                  <td className="px-3 py-2">{charge.source === "credit_balance" ? "Credit" : charge.source === "invoice" ? "Invoice" : "Allowance"}</td>
                  <td className="px-3 py-2">{charge.status === "posted" ? "Charged" : `Refunded${charge.reversedAt ? ` ${formatShort(charge.reversedAt)}` : ""}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
