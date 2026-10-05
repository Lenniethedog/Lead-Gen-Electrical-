import type { Metadata } from "next";
import Link from "next/link";
import { formatFull } from "@/app/admin/_format";
import { DISPUTE_REASONS, DISPUTE_STATUS_LABELS } from "@/config/disputes";
import { loadDisputeList } from "@/server/client/portal";
import { cardClass, linkClass } from "../../../admin/_components/styles";

export const metadata: Metadata = { title: "Problems you reported" };

export default async function DisputesPage() {
  const disputes = await loadDisputeList();
  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Problems you reported</h1>
      <p className="mt-1 text-muted">If a lead has a problem, open it and choose &ldquo;Report a problem&rdquo; within 7 days. We look at every one. If we agree, you are refunded.</p>
      {disputes.length === 0 ? (
        <p className="mt-6 rounded-lg border border-stone-200 bg-white px-4 py-8 text-center text-muted">You have not reported any problems.</p>
      ) : (
        <ul className="mt-4 space-y-3">
          {disputes.map((dispute) => (
            <li key={dispute.id} className={cardClass}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link href={`/dashboard/leads/${dispute.assignmentId}`} className={`${linkClass} font-mono`}>{dispute.reference}</Link>
                <span className="font-semibold">{DISPUTE_STATUS_LABELS[dispute.status]}</span>
              </div>
              <p className="mt-1">{DISPUTE_REASONS[dispute.reason]}</p>
              <p className="text-sm text-muted">Reported {formatFull(dispute.createdAt)}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
