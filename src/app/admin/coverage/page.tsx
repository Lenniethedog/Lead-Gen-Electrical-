import type { Metadata } from "next";
import Link from "next/link";
import { REASON_TEXT } from "@/modules/coverage/reasons";
import { loadCoverageTester } from "@/server/admin/clients";
import { ClientStatusBadge } from "../_components/Badges";
import { cardClass, inputClass, labelClass, linkClass, primaryButton } from "../_components/styles";

export const metadata: Metadata = { title: "Coverage tester" };

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default async function CoveragePage(props: PageProps<"/admin/coverage">) {
  const query = await props.searchParams;
  const params = { postcode: first(query.postcode), service: first(query.service), sale: first(query.sale) };
  const { services, result } = await loadCoverageTester(params);

  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Coverage tester</h1>
      <p className="mt-2 max-w-3xl text-muted">
        Which clients would be offered a lead at a postcode? This uses <strong>exactly the same rules</strong> as handing a lead to a business, and says why each client is or is not eligible.
      </p>

      <form method="get" className={`${cardClass} mt-4 grid gap-4 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end`}>
        <div>
          <label htmlFor="postcode" className={labelClass}>Postcode</label>
          <input id="postcode" name="postcode" defaultValue={params.postcode ?? ""} placeholder="BR6 0AA" autoComplete="off" required className={inputClass} />
        </div>
        <div>
          <label htmlFor="service" className={labelClass}>Service</label>
          <select id="service" name="service" defaultValue={params.service ?? services[0]?.slug} className={inputClass}>
            {services.map((service) => (
              <option key={service.slug} value={service.slug}>{service.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="sale" className={labelClass}>Lead type</label>
          <select id="sale" name="sale" defaultValue={params.sale === "shared" ? "shared" : "exclusive"} className={inputClass}>
            <option value="exclusive">Exclusive</option>
            <option value="shared">Shared</option>
          </select>
        </div>
        <button type="submit" className={primaryButton}>Check</button>
      </form>

      {result?.kind === "invalid_postcode" && (
        <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">That does not look like a UK postcode. Enter a full postcode such as BR6 0AA.</p>
      )}
      {result?.kind === "unknown_service" && <p role="alert" className="mt-4 text-red-900">Choose a service.</p>}
      {result?.kind === "explained" && result.explanation.status === "unknown_postcode" && (
        <p role="alert" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950">
          That postcode is not in the postcode directory, so no client can be matched. (A lead from it would have been refused at the form.)
        </p>
      )}
      {result?.kind === "explained" && result.explanation.status === "ok" && (
        <section aria-labelledby="results-heading" className="mt-6">
          <h2 id="results-heading" className="text-xl font-bold text-ink">
            {result.explanation.postcode} · {result.serviceLabel} · {result.saleType}
          </h2>
          {!result.explanation.hasCoordinates && (
            <p className="mt-1 text-sm text-muted">This postcode has no coordinates, so distance (&ldquo;within N miles&rdquo;) rules cannot match it.</p>
          )}
          {(() => {
            const { clients } = result.explanation;
            const eligible = clients.filter((client) => client.eligible).length;
            return (
              <>
                <p className="mt-2 text-lg" role="status">
                  <strong>{eligible}</strong> of {clients.length} client{clients.length === 1 ? "" : "s"} would be offered this lead.
                </p>
                {clients.length === 0 ? (
                  <p className={`${cardClass} mt-3 text-muted`}>There are no clients yet.</p>
                ) : (
                  <div className="relative mt-3 overflow-x-auto rounded-lg border border-stone-200 bg-white">
                    <table className="w-full min-w-[44rem] text-left">
                      <caption className="sr-only">Eligibility of each client</caption>
                      <thead className="border-b border-stone-200 bg-stone-100 text-sm text-muted">
                        <tr>
                          <th scope="col" className="px-4 py-3 font-semibold">Client</th>
                          <th scope="col" className="px-4 py-3 font-semibold">Verdict</th>
                          <th scope="col" className="px-4 py-3 font-semibold">Why</th>
                          <th scope="col" className="px-4 py-3 font-semibold">Rules that match this postcode</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-stone-200">
                        {clients.map((client) => (
                          <tr key={client.clientId} className={client.eligible ? "bg-green-50" : undefined}>
                            <td className="px-4 py-3 align-top">
                              <Link href={`/admin/clients/${client.clientId}`} className={linkClass}>{client.name}</Link>
                              <div className="mt-1"><ClientStatusBadge status={client.status} /></div>
                            </td>
                            <td className="px-4 py-3 align-top font-semibold">{client.eligible ? "Eligible" : "Not eligible"}</td>
                            <td className="px-4 py-3 align-top">
                              {client.reasons.length === 0 ? <span className="text-muted">Meets every condition</span> : (
                                <ul className="list-disc space-y-1 pl-5">
                                  {client.reasons.map((reason) => (<li key={reason}>{REASON_TEXT[reason]}</li>))}
                                </ul>
                              )}
                            </td>
                            <td className="px-4 py-3 align-top">
                              {client.matchedRules.length === 0 ? <span className="text-muted">None</span> : (
                                <ul className="space-y-1">
                                  {client.matchedRules.map((rule) => (
                                    <li key={rule.id}>
                                      <span className={`mr-2 inline-flex rounded-full px-2 py-0.5 text-sm font-semibold ${rule.mode === "include" ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
                                        {rule.mode === "include" ? "Include" : "Exclude"}
                                      </span>
                                      {rule.label}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}
        </section>
      )}
    </>
  );
}
