import type { Metadata } from "next";
import Link from "next/link";
import { DISPUTE_DECISION_REASONS, DISPUTE_REASONS, DISPUTE_RESOLUTIONS, DISPUTE_STATUS_LABELS } from "@/config/disputes";
import { formatPence } from "@/modules/pricing/schemas";
import { loadDisputeQueue } from "@/server/admin/disputes";
import { cardClass, hintClass, inputClass, labelClass, linkClass, primaryButton } from "../_components/styles";
import { ERRORS, NOTICES } from "../_messages";
import { formatShort, waitingLabel } from "../_format";
import { decideDisputeAction } from "./actions";

export const metadata: Metadata = { title: "Disputes" };

export default async function DisputesPage(props: PageProps<"/admin/disputes">) {
  const query = await props.searchParams;
  const { open, decided } = await loadDisputeQueue();
  const now = new Date();
  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;

  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Disputes</h1>
      <p className="mt-1 max-w-3xl text-muted">A business says there is a problem with a lead. <strong>Uphold</strong> and the charge is refunded, the lead comes back to you and is NOT offered to anyone else by itself (decide what to do with it). <strong>Not upheld</strong> and the business keeps the lead and the charge. Each decision needs a reason from the list.</p>
      {notice && <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">{error}</p>}

      <h2 className="mt-6 text-xl font-bold text-ink">Waiting for a decision ({open.length})</h2>
      {open.length === 0 ? <p className="mt-2 rounded-lg border border-stone-200 bg-white px-4 py-6 text-center text-muted">Nothing is waiting.</p> : (
        <ul className="mt-3 space-y-4">
          {open.map((dispute) => (
            <li key={dispute.id} className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <Link href={`/admin/clients/${dispute.clientId}`} className={`${linkClass} text-lg`}>{dispute.clientName}</Link>
                  <span className="text-muted"> · lead </span>
                  <span className="font-mono">{dispute.reference}</span>
                  <span className="text-muted"> · charged {formatPence(dispute.chargePence)}</span>
                </div>
                <span className="text-sm text-muted">waiting {waitingLabel(dispute.createdAt, now)} · reported by {dispute.raisedBy}</span>
              </div>
              <p className="mt-2"><span className="font-semibold">{DISPUTE_REASONS[dispute.reason]}.</span></p>
              {dispute.description && <p className="mt-1 whitespace-pre-line rounded bg-stone-50 p-3">{dispute.description}</p>}
              <form action={decideDisputeAction} className="mt-4 grid gap-3 sm:grid-cols-3">
                <input type="hidden" name="disputeId" value={dispute.id} />
                <div>
                  <label htmlFor={`outcome-${dispute.id}`} className={labelClass}>Decision</label>
                  <select id={`outcome-${dispute.id}`} name="outcome" required defaultValue="" className={inputClass}>
                    <option value="" disabled>Choose</option>
                    <option value="uphold">Uphold: refund the charge</option>
                    <option value="reject">Do not uphold</option>
                  </select>
                </div>
                <div>
                  <label htmlFor={`reason-${dispute.id}`} className={labelClass}>Because</label>
                  <select id={`reason-${dispute.id}`} name="decisionReason" required defaultValue="" className={inputClass}>
                    <option value="" disabled>Choose</option>
                    <optgroup label="If upholding">
                      {Object.entries(DISPUTE_DECISION_REASONS).filter(([, r]) => r.outcome === "upheld").map(([code, r]) => <option key={code} value={code}>{r.label}</option>)}
                    </optgroup>
                    <optgroup label="If not upholding">
                      {Object.entries(DISPUTE_DECISION_REASONS).filter(([, r]) => r.outcome === "rejected").map(([code, r]) => <option key={code} value={code}>{r.label}</option>)}
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label htmlFor={`resolution-${dispute.id}`} className={labelClass}>If upholding</label>
                  <select id={`resolution-${dispute.id}`} name="resolution" defaultValue="credit_refund" className={inputClass}>
                    {Object.entries(DISPUTE_RESOLUTIONS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                  </select>
                </div>
                <div className="sm:col-span-3"><button type="submit" className={primaryButton}>Record the decision</button></div>
              </form>
              <p className={`mt-2 ${hintClass}`}>The reason must match the decision. It is saved with your name.</p>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-xl font-bold text-ink">Recently decided</h2>
      {decided.length === 0 ? <p className="mt-2 text-muted">None yet.</p> : (
        <div tabIndex={0} role="region" aria-label="Recently decided disputes" className="mt-3 overflow-x-auto rounded-lg border border-stone-200 bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <caption className="sr-only">Recently decided disputes, newest first</caption>
            <thead className="bg-stone-100 text-muted"><tr><th scope="col" className="px-3 py-2">Decided</th><th scope="col" className="px-3 py-2">Business</th><th scope="col" className="px-3 py-2">Lead</th><th scope="col" className="px-3 py-2">Problem</th><th scope="col" className="px-3 py-2">Outcome</th><th scope="col" className="px-3 py-2">By</th></tr></thead>
            <tbody className="divide-y divide-stone-200">
              {decided.map((dispute) => (
                <tr key={dispute.id}>
                  <td className="px-3 py-2">{formatShort(dispute.decidedAt ?? dispute.createdAt)}</td>
                  <td className="px-3 py-2">{dispute.clientName}</td>
                  <td className="px-3 py-2 font-mono">{dispute.reference}</td>
                  <td className="px-3 py-2">{DISPUTE_REASONS[dispute.reason]}</td>
                  <td className="px-3 py-2">{DISPUTE_STATUS_LABELS[dispute.status]}{dispute.decisionReason && dispute.decisionReason in DISPUTE_DECISION_REASONS ? <span className="block text-muted">{DISPUTE_DECISION_REASONS[dispute.decisionReason as keyof typeof DISPUTE_DECISION_REASONS].label}</span> : null}</td>
                  <td className="px-3 py-2">{dispute.decidedBy ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
