import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { APPROVE_REASONS, REJECT_REASONS } from "@/config/review";
import { OWNERSHIPS, PROPERTY_TYPES, type Ownership, type PropertyType } from "@/config/lead-options";
import { loadLeadWork } from "@/server/admin/assignments";
import { loadLeadDetail } from "@/server/admin/inbox";
import { loadLeadRouting } from "@/server/admin/routing";
import { AlertState, StatusBadge, UrgencyBadge } from "../../_components/Badges";
import { formatFull, formatShort, isOverdue, mailtoHref, waitingLabel } from "../../_format";
import { REASON_TEXT } from "@/modules/coverage/reasons";
import type { NotEligibleReason } from "@/modules/coverage";
import { ERRORS as SHARED_ERRORS, NOTICES as SHARED_NOTICES } from "../../_messages";
import { decideLeadAction, handleLeadAction } from "../actions";
import { AssignmentPanel } from "./_sections/AssignmentPanel";
import { PrivacyPanel } from "./_sections/PrivacyPanel";
import { RoutingPanel } from "./_sections/RoutingPanel";

export const metadata: Metadata = { title: "Lead" };

const NOTICES: Record<string, string> = {
  ...SHARED_NOTICES,
  approved: "Lead approved. It is now a new lead waiting for you.",
  rejected: "Lead rejected.",
  handled: "Marked as handled.",
};
const ERRORS: Record<string, string> = {
  ...SHARED_ERRORS,
  not_held: "That lead is not held for review any more (someone may have decided it already). Nothing was changed.",
  not_open: "That lead cannot be marked as handled in its current state.",
  not_found: "That lead no longer exists.",
  invalid_reason: "Choose one of the listed reasons. Nothing was changed.",
  invalid_request: "That request was not valid. Nothing was changed.",
};

const selectClass =
  "min-h-12 w-full rounded-lg border-2 border-stone-400 bg-white px-3 text-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300";
const buttonClass =
  "inline-flex min-h-12 items-center justify-center rounded-lg px-6 py-3 text-lg font-semibold focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-300";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 py-1.5 sm:grid-cols-[10rem_1fr]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-ink">{children}</dd>
    </div>
  );
}

export default async function LeadPage(props: PageProps<"/admin/leads/[id]">) {
  const [{ id }, query] = await Promise.all([props.params, props.searchParams]);
  const loaded = await loadLeadDetail(id);
  if (!loaded) notFound();
  const { lead } = loaded;
  const work = await loadLeadWork(lead.id);
  const routing = await loadLeadRouting(lead.id, { explain: query.explain === "routing" });
  const withdrawn = lead.consent?.withdrawnAt != null;
  // `unroutable` is the lead the router found nobody for: exactly the one an operator may hand over by hand.
  const canAssign = (lead.status === "new" || lead.status === "unroutable") && !lead.erased && !withdrawn;
  const now = new Date();

  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;
  const whyList = typeof query.why === "string" ? query.why.split(",").filter((code): code is NotEligibleReason => code in REASON_TEXT).map((code) => REASON_TEXT[code]) : [];
  const error = typeof query.error === "string" ? `${ERRORS[query.error] ?? ""}${whyList.length > 0 ? ` (${whyList.join("; ")}.)` : ""}`.trim() || undefined : undefined;
  // Needs a person: held, new/unroutable and nobody dealt with it, or assigned but not yet sent to the business.
  const unsent = lead.status === "assigned" && work.assignments.some((assignment) => assignment.active && assignment.status === "reserved");
  const waiting = lead.status === "held" || ((lead.status === "new" || lead.status === "unroutable") && !lead.handled) || unsent;

  return (
    <>
      <p>
        <Link href="/admin/leads" className="text-brand-800 underline">
          &larr; All leads
        </Link>
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-2xl font-extrabold text-ink">{lead.reference}</h1>
        <StatusBadge status={lead.status} handled={lead.handled} unsent={unsent} />
        <UrgencyBadge urgency={lead.urgency} />
      </div>
      <p className={`mt-1 ${waiting && isOverdue(lead.receivedAt, now) ? "font-bold text-error" : "text-muted"}`}>
        Received {formatShort(lead.receivedAt)} ({waiting ? `waiting ${waitingLabel(lead.receivedAt, now)}` : `${waitingLabel(lead.receivedAt, now)} ago`})
      </p>

      {notice && (
        <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">
          {error}
        </p>
      )}

      {lead.status === "held" && (
        <section aria-labelledby="review-heading" className="mt-6 rounded-lg border-2 border-amber-400 bg-amber-50 p-4 sm:p-6">
          <h2 id="review-heading" className="text-xl font-bold text-ink">
            Decide on this held lead
          </h2>
          <p className="mt-1 text-amber-950">
            The screening held this lead (score {lead.fraudScore}). It will not be used until you decide. See the signals below.
          </p>
          <div className="mt-4 grid gap-6 md:grid-cols-2">
            <form action={decideLeadAction} className="space-y-3">
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="decision" value="approve" />
              <label className="block font-semibold" htmlFor="approve-reason">
                Approve because&hellip;
              </label>
              <select id="approve-reason" name="reason" required defaultValue="" className={selectClass}>
                <option value="" disabled>Choose a reason</option>
                {Object.entries(APPROVE_REASONS).map(([code, text]) => (
                  <option key={code} value={code}>{text}</option>
                ))}
              </select>
              <button type="submit" className={`${buttonClass} bg-green-700 text-white hover:bg-green-800`}>
                Approve lead
              </button>
            </form>
            <form action={decideLeadAction} className="space-y-3">
              <input type="hidden" name="leadId" value={lead.id} />
              <input type="hidden" name="decision" value="reject" />
              <label className="block font-semibold" htmlFor="reject-reason">
                Reject because&hellip;
              </label>
              <select id="reject-reason" name="reason" required defaultValue="" className={selectClass}>
                <option value="" disabled>Choose a reason</option>
                {Object.entries(REJECT_REASONS).map(([code, text]) => (
                  <option key={code} value={code}>{text}</option>
                ))}
              </select>
              <button type="submit" className={`${buttonClass} border-2 border-red-700 bg-white text-red-800 hover:bg-red-50`}>
                Reject lead
              </button>
            </form>
          </div>
        </section>
      )}

      {(lead.status === "new" || lead.status === "unroutable") && !lead.handled && (
        <section aria-labelledby="handle-heading" className="mt-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
          <h2 id="handle-heading" className="text-xl font-bold text-ink">
            Dealt with this lead?
          </h2>
          <p className="mt-1 text-muted">
            Mark it handled once you have passed it on or decided what to do. It leaves &ldquo;Needs action&rdquo; and no reminder will be sent.
            Keep your own log of which business received it: a lead may go to one business only.
          </p>
          <form action={handleLeadAction} className="mt-4">
            <input type="hidden" name="leadId" value={lead.id} />
            <button type="submit" className={`${buttonClass} bg-brand-700 text-white hover:bg-brand-800`}>
              Mark as handled
            </button>
          </form>
        </section>
      )}

      {(canAssign || work.assignments.length > 0) && <AssignmentPanel leadId={lead.id} canAssign={canAssign} work={work} />}

      <RoutingPanel leadId={lead.id} runs={routing.runs} explanation={routing.explanation} canExplain={!lead.erased && ["new", "unroutable", "assigned", "held"].includes(lead.status)} />

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="contact-heading" className="rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
          <h2 id="contact-heading" className="text-xl font-bold text-ink">
            Contact
          </h2>
          {lead.contact ? (
            <dl className="mt-2">
              <Field label="Name">{lead.contact.name}</Field>
              <Field label="Phone">
                <a className="text-brand-800 underline" href={`tel:${lead.contact.phone}`}>
                  {lead.contact.phone}
                </a>
              </Field>
              <Field label="Email">
                <a className="text-brand-800 underline" href={mailtoHref(lead.contact.email)}>
                  {lead.contact.email}
                </a>
              </Field>
              {lead.contact.notes && <Field label="Their note"><span className="whitespace-pre-wrap">{lead.contact.notes}</span></Field>}
            </dl>
          ) : (
            <p className="mt-2 text-muted">Contact details have been erased.</p>
          )}
          <p className="mt-3 text-sm text-muted">Personal data: use it only to respond to this enquiry.</p>
        </section>

        <section aria-labelledby="job-heading" className="rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
          <h2 id="job-heading" className="text-xl font-bold text-ink">
            The job
          </h2>
          <dl className="mt-2">
            <Field label="Service">{lead.serviceLabel}</Field>
            <Field label="Postcode">{lead.postcode ?? `${lead.postcodeOutward} (full postcode erased)`}</Field>
            <Field label="Property">{PROPERTY_TYPES[lead.propertyType as PropertyType]?.label ?? lead.propertyType}</Field>
            <Field label="Connection">{OWNERSHIPS[lead.ownership as Ownership]?.label ?? lead.ownership}</Field>
            {lead.scope && <Field label="Work needed">{lead.scope.replace(/_/g, " ")}</Field>}
            {lead.duplicateOfReference && <Field label="Duplicate of">{lead.duplicateOfReference}</Field>}
          </dl>
        </section>

        <section aria-labelledby="screen-heading" className="rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
          <h2 id="screen-heading" className="text-xl font-bold text-ink">
            Screening
          </h2>
          <p className="mt-2">
            Score <strong>{lead.fraudScore}</strong> of 100: {lead.fraudDecision}
          </p>
          {lead.signals.length > 0 ? (
            <ul className="mt-2 list-disc space-y-1 pl-6">
              {lead.signals.map((signal) => (
                <li key={signal.code}>
                  <span className="font-mono">{signal.code}</span> <span className="text-muted">(+{signal.weight})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-muted">No warning signals.</p>
          )}
          {lead.consent && (
            <p className="mt-3 text-sm text-muted">
              Consent {lead.consent.version} recorded {formatFull(lead.consent.capturedAt)}.
            </p>
          )}
          {lead.attribution && (lead.attribution.source || lead.attribution.campaign) && (
            <p className="mt-1 text-sm text-muted">
              Source: {[lead.attribution.source, lead.attribution.medium, lead.attribution.campaign].filter(Boolean).join(" / ")}
            </p>
          )}
        </section>

        <section aria-labelledby="alerts-heading" className="rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
          <h2 id="alerts-heading" className="text-xl font-bold text-ink">
            Email alerts
          </h2>
          {lead.alerts.length === 0 ? (
            <p className="mt-2"><AlertState state="none" /></p>
          ) : (
            <ul className="mt-2 space-y-1">
              {lead.alerts.map((alert) => (
                <li key={alert.kind}>
                  <span className="font-semibold">{alert.kind.replace("_", " ")}</span>: <AlertState state={alert.status} />
                  {alert.sentAt && <span className="text-sm text-muted"> at {formatShort(alert.sentAt)}</span>}
                  {alert.status !== "sent" && alert.errorCode && <span className="text-sm text-muted"> ({alert.errorCode}, {alert.attempts} tries)</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <PrivacyPanel leadId={lead.id} erased={lead.erased} withdrawn={withdrawn} work={work} />

      <section aria-labelledby="timeline-heading" className="mt-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
        <h2 id="timeline-heading" className="text-xl font-bold text-ink">
          Timeline
        </h2>
        <ol className="mt-3 space-y-2">
          {lead.timeline.map((entry, index) => (
            <li key={index} className="grid gap-x-4 sm:grid-cols-[11rem_1fr]">
              <time dateTime={entry.at.toISOString()} className="text-sm text-muted">{formatFull(entry.at)}</time>
              <span>
                {entry.text} <span className="text-sm text-muted">&mdash; {entry.actor}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
