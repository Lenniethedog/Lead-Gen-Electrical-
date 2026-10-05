import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { formatFull, mailtoHref, waitingLabel } from "@/app/admin/_format";
import { OWNERSHIPS, PROPERTY_TYPES, URGENCIES, type Ownership, type PropertyType } from "@/config/lead-options";
import { loadLeadForClient } from "@/server/client/portal";
import { cardClass, hintClass, linkClass, primaryButton, secondaryButton } from "../../../../admin/_components/styles";
import { LeadStatusBadge, TimingBadge } from "../../../_components/StatusBadge";

export const metadata: Metadata = { title: "Lead" };

export default async function LeadPage(props: PageProps<"/dashboard/leads/[id]">) {
  const { id } = await props.params;
  const lead = await loadLeadForClient(id);
  if (!lead) notFound();
  const now = new Date();

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
    </>
  );
}
