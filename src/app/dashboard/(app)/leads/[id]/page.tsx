import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatFull, mailtoHref, waitingLabel } from "@/app/admin/_format";
import { CLIENT_DECLINE_REASONS } from "@/config/assignment";
import { CONTACT_OUTCOMES } from "@/config/client-dashboard";
import { OWNERSHIPS, PROPERTY_TYPES, URGENCIES, type Ownership, type PropertyType } from "@/config/lead-options";
import { loadLeadForClient } from "@/server/client/portal";
import { cardClass, dangerButton, hintClass, inputClass, labelClass, linkClass, primaryButton, secondaryButton } from "../../../../admin/_components/styles";
import { acceptAction, declineAction, logContactAction } from "./actions";
import { LeadStatusBadge, TimingBadge } from "../../../_components/StatusBadge";

export const metadata: Metadata = { title: "Lead" };

const NOTICES: Record<string, string> = {
  accepted: "Accepted. It is yours. Ring them as soon as you can, then record how it went below.",
  logged: "Saved.",
};
const ERRORS: Record<string, string> = {
  not_open: "That lead has already been answered, so nothing was changed.",
  not_accepted: "Accept the lead before recording a call.",
  invalid_reason: "Choose why you are declining it.",
  invalid_outcome: "Choose what happened.",
  invalid_value: "Enter the amount in pounds, like 1,500 or 480.50, and only for a quote or a job won.",
  invalid_note: "Keep the note under 1,000 characters.",
  invalid_request: "That request was not valid. Nothing was changed.",
  not_found: "That lead could not be found.",
};

export default async function LeadPage(props: PageProps<"/dashboard/leads/[id]">) {
  const [{ id }, query] = await Promise.all([props.params, props.searchParams]);
  const lead = await loadLeadForClient(id);
  if (!lead) notFound();
  const now = new Date();
  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;
  const unanswered = lead.status === "reserved" || lead.status === "notified";
  const canLog = lead.status === "accepted" || lead.status === "disputed";

  return (
    <>
      <p><Link href="/dashboard" className={linkClass}>&larr; New leads</Link></p>
      <h1 className="mt-3 flex flex-wrap items-center gap-3 text-2xl font-extrabold text-ink">
        {lead.serviceLabel}
        <TimingBadge urgency={lead.urgency} />
        <LeadStatusBadge status={lead.status} />
      </h1>
      <p className="mt-1 text-muted">
        <span className="font-mono">{lead.reference}</span> · sent to you {waitingLabel(lead.assignedAt, now)} ago ({formatFull(lead.assignedAt)})
      </p>

      {notice && <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">{error}</p>}

      {unanswered && (
        <section id="respond" aria-labelledby="respond-heading" className={`${cardClass} mt-6 border-brand-700`}>
          <h2 id="respond-heading" className="text-xl font-bold text-ink">Do you want this lead?</h2>
          <p className={hintClass}>It was sent only to you. Accept it to start work; decline it and it goes to another business.</p>
          <form action={acceptAction} className="mt-4">
            <input type="hidden" name="assignmentId" value={lead.assignmentId} />
            <button type="submit" className={`${primaryButton} w-full sm:w-auto`}>Accept this lead</button>
          </form>
          <form action={declineAction} className="mt-6 flex flex-col gap-3 border-t border-stone-200 pt-4 sm:flex-row sm:items-end">
            <input type="hidden" name="assignmentId" value={lead.assignmentId} />
            <div className="flex-1">
              <label htmlFor="decline-reason" className={labelClass}>Or decline it, because</label>
              <select id="decline-reason" name="reason" required defaultValue="" className={inputClass}>
                <option value="" disabled>Choose a reason</option>
                {Object.entries(CLIENT_DECLINE_REASONS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </div>
            <button type="submit" className={dangerButton}>Decline</button>
          </form>
        </section>
      )}

      {lead.contact ? (
        <section aria-labelledby="contact-heading" className={`${cardClass} mt-6`}>
          <h2 id="contact-heading" className="text-xl font-bold text-ink">Contact {lead.contact.name}</h2>
          <p className={hintClass}>They asked to be contacted about this job and agreed to share their details with one local roofing business. Use them only for this enquiry.</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <a href={`tel:${lead.contact.phone}`} className={primaryButton}>Call {lead.contact.phone}</a>
            <a href={mailtoHref(lead.contact.email)} className={secondaryButton}>Email {lead.contact.email}</a>
          </div>
          {lead.contact.notes && (
            <p className="mt-4"><span className="font-semibold">Note from them:</span> {lead.contact.notes}</p>
          )}
        </section>
      ) : (
        <section aria-labelledby="contact-heading" className={`${cardClass} mt-6`}>
          <h2 id="contact-heading" className="text-xl font-bold text-ink">Contact details</h2>
          <p className="mt-2">
            {lead.contactState === "erased"
              ? "This person has asked us to erase their details, so they are no longer available."
              : "This lead is no longer with you, so the person's contact details are not shown."}
          </p>
        </section>
      )}

      <section aria-labelledby="job-heading" className={`${cardClass} mt-4`}>
        <h2 id="job-heading" className="text-xl font-bold text-ink">The job</h2>
        <dl className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div><dt className="text-sm text-muted">Work</dt><dd className="font-semibold">{lead.serviceLabel}{lead.scope ? ` (${lead.scope.replace(/_/g, " ")})` : ""}</dd></div>
          <div><dt className="text-sm text-muted">Timing</dt><dd className="font-semibold">{URGENCIES[lead.urgency].label}{URGENCIES[lead.urgency].hint ? `: ${URGENCIES[lead.urgency].hint}` : ""}</dd></div>
          <div><dt className="text-sm text-muted">Property</dt><dd className="font-semibold">{PROPERTY_TYPES[lead.propertyType as PropertyType]?.label ?? lead.propertyType}, {OWNERSHIPS[lead.ownership as Ownership]?.label.toLowerCase() ?? lead.ownership}</dd></div>
          <div><dt className="text-sm text-muted">{lead.postcode ? "Postcode" : "Area"}</dt><dd className="font-semibold">{lead.postcode ?? lead.district}</dd></div>
        </dl>
      </section>

      {(canLog || lead.attempts.length > 0) && (
        <section id="calls" aria-labelledby="calls-heading" className={`${cardClass} mt-4`}>
          <h2 id="calls-heading" className="text-xl font-bold text-ink">What happened</h2>
          {lead.attempts.length === 0 ? (
            <p className={`mt-1 ${hintClass}`}>Nothing recorded yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-stone-200">
              {lead.attempts.map((attempt) => (
                <li key={attempt.id} className="py-2">
                  <span className="font-semibold">{CONTACT_OUTCOMES[attempt.outcome]}</span>
                  {attempt.jobValuePence !== null && <span> · £{(attempt.jobValuePence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                  <span className="text-muted"> · {formatFull(attempt.occurredAt)}{attempt.by ? ` · ${attempt.by}` : ""}</span>
                  {attempt.note && <p className="mt-1">{attempt.note}</p>}
                </li>
              ))}
            </ul>
          )}
          {canLog && (
            <form action={logContactAction} className="mt-4 grid gap-3 sm:grid-cols-2">
              <input type="hidden" name="assignmentId" value={lead.assignmentId} />
              <div>
                <label htmlFor="outcome" className={labelClass}>How did it go?</label>
                <select id="outcome" name="outcome" required defaultValue="" className={inputClass}>
                  <option value="" disabled>Choose</option>
                  {Object.entries(CONTACT_OUTCOMES).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="jobValue" className={labelClass}>Value of the quote or job (optional)</label>
                <input id="jobValue" name="jobValue" inputMode="decimal" autoComplete="off" placeholder="1,500" aria-describedby="value-hint" className={inputClass} />
                <p id="value-hint" className={hintClass}>In pounds. Only for a quote sent or a job won.</p>
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="note" className={labelClass}>Note (optional)</label>
                <textarea id="note" name="note" rows={2} maxLength={1000} className={`${inputClass} py-2`} />
              </div>
              <div className="sm:col-span-2"><button type="submit" className={secondaryButton}>Save</button></div>
            </form>
          )}
        </section>
      )}
    </>
  );
}
