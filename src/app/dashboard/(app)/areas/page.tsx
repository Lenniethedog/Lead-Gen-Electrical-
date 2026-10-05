import type { Metadata } from "next";
import { formatFull } from "@/app/admin/_format";
import { CHANGE_REQUEST_KINDS } from "@/modules/portal";
import { loadServiceAreaPage } from "@/server/client/portal";
import { cardClass, hintClass, inputClass, labelClass, secondaryButton } from "../../../admin/_components/styles";
import { requestChangeAction } from "./actions";

export const metadata: Metadata = { title: "Where you work" };

const ERRORS: Record<string, string> = {
  invalid_kind: "Choose what you want changed.",
  invalid_message: "Tell us what you would like changed (5 to 1,000 characters).",
  too_many: "You already have five requests waiting. We will deal with those first.",
  forbidden: "Only an owner or manager can ask for changes.",
};

export default async function AreasPage(props: PageProps<"/dashboard/areas">) {
  const [{ view, requests, canRequest }, query] = await Promise.all([loadServiceAreaPage(), props.searchParams]);
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;
  const includes = view.rules.filter((rule) => rule.mode === "include");
  const excludes = view.rules.filter((rule) => rule.mode === "exclude");

  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Where and what you cover</h1>
      <p className="mt-1 max-w-3xl text-muted">This decides which leads are sent to you. We set it up with you; to change it, ask below and we will do it for you.</p>

      <section aria-labelledby="work-heading" className={`${cardClass} mt-4`}>
        <h2 id="work-heading" className="text-xl font-bold text-ink">The work you take</h2>
        {view.services.length === 0 ? <p className="mt-1">Nothing is set up yet.</p> : <ul className="mt-2 list-disc pl-6">{view.services.map((service) => <li key={service}>{service}</li>)}</ul>}
      </section>

      <section aria-labelledby="area-heading" className={`${cardClass} mt-4`}>
        <h2 id="area-heading" className="text-xl font-bold text-ink">Where you work</h2>
        {includes.length === 0 ? <p className="mt-1">Nothing is set up yet.</p> : <ul className="mt-2 list-disc pl-6">{includes.map((rule) => <li key={rule.description}>{rule.description}</li>)}</ul>}
        {excludes.length > 0 && (
          <>
            <h3 className="mt-4 font-semibold text-ink">Except</h3>
            <ul className="mt-1 list-disc pl-6">{excludes.map((rule) => <li key={rule.description}>{rule.description}</li>)}</ul>
          </>
        )}
      </section>

      <section id="requests" aria-labelledby="request-heading" className={`${cardClass} mt-4`}>
        <h2 id="request-heading" className="text-xl font-bold text-ink">Ask for a change</h2>
        {query.notice === "requested" && <p role="status" className="mt-2 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">Thank you. We have your request and will be in touch.</p>}
        {error && <p role="alert" className="mt-2 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">{error}</p>}
        {canRequest ? (
          <form action={requestChangeAction} className="mt-3 grid gap-3">
            <div>
              <label htmlFor="change-kind" className={labelClass}>What would you like changed</label>
              <select id="change-kind" name="kind" required defaultValue="" className={inputClass}>
                <option value="" disabled>Choose</option>
                {Object.entries(CHANGE_REQUEST_KINDS).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="change-message" className={labelClass}>Tell us what you would like</label>
              <textarea id="change-message" name="message" rows={3} required minLength={5} maxLength={1000} className={`${inputClass} py-2`} />
              <p className={hintClass}>For example &ldquo;please add BR1 and BR2&rdquo;. Please do not include customers&rsquo; details.</p>
            </div>
            <div><button type="submit" className={secondaryButton}>Send request</button></div>
          </form>
        ) : <p className={`mt-1 ${hintClass}`}>An owner or manager can ask for changes.</p>}

        {requests.length > 0 && (
          <>
            <h3 className="mt-5 font-semibold text-ink">Your requests</h3>
            <ul className="mt-1 divide-y divide-stone-200">
              {requests.map((request) => (
                <li key={request.id} className="py-2">
                  <span className="font-semibold">{CHANGE_REQUEST_KINDS[request.kind]}</span> · {request.status === "done" ? "Done" : "Waiting"} <span className="text-muted">· {formatFull(request.createdAt)}</span>
                  <p>{request.message}</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </>
  );
}
