import type { Metadata } from "next";
import { URGENCIES, URGENCY_VALUES } from "@/config/lead-options";
import { formatPence } from "@/modules/pricing/schemas";
import { loadPricing } from "@/server/admin/pricing";
import { cardClass, hintClass, inputClass, labelClass, primaryButton } from "../_components/styles";
import { ERRORS, NOTICES } from "../_messages";
import { formatShort } from "../_format";
import { endPriceAction, setPriceAction } from "./actions";

export const metadata: Metadata = { title: "Pricing" };

export default async function PricingPage(props: PageProps<"/admin/pricing">) {
  const [{ rules, services, areas }, query] = await Promise.all([loadPricing(), props.searchParams]);
  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;
  const error = typeof query.error === "string" ? (typeof query.detail === "string" ? query.detail : ERRORS[query.error]) : undefined;
  const current = rules.filter((rule) => rule.state !== "ended");
  const ended = rules.filter((rule) => rule.state === "ended");

  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Pricing</h1>
      <p className="mt-2 max-w-3xl text-muted">
        What a lead costs a business. When a lead is handed over, the <strong>most specific</strong> matching rule applies (one naming a service, an area and an urgency beats one naming fewer). The price is
        copied onto the assignment, so changing a rule never changes what a business was already charged. Nothing is charged automatically yet: this is the price you invoice.
      </p>
      {notice && <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">{error}</p>}

      <section aria-labelledby="set-heading" className={`${cardClass} mt-6`}>
        <h2 id="set-heading" className="text-xl font-bold text-ink">Set a price</h2>
        <p className={`mt-1 ${hintClass}`}>Setting a price for a combination that already has one ends the old rule and starts the new one now. Leave a field as &ldquo;Any&rdquo; to make the rule general.</p>
        <form action={setPriceAction} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="serviceSlug" className={labelClass}>Service</label>
            <select id="serviceSlug" name="serviceSlug" defaultValue="" className={inputClass}>
              <option value="">Any service</option>
              {services.map((service) => (<option key={service.slug} value={service.slug}>{service.label}</option>))}
            </select>
          </div>
          <div>
            <label htmlFor="serviceAreaSlug" className={labelClass}>Area</label>
            <select id="serviceAreaSlug" name="serviceAreaSlug" defaultValue="" className={inputClass}>
              <option value="">Anywhere</option>
              {areas.map((area) => (<option key={area.slug} value={area.slug}>{area.name}</option>))}
            </select>
          </div>
          <div>
            <label htmlFor="urgency" className={labelClass}>Urgency</label>
            <select id="urgency" name="urgency" defaultValue="" className={inputClass}>
              <option value="">Any urgency</option>
              {URGENCY_VALUES.map((value) => (<option key={value} value={value}>{URGENCIES[value].label}</option>))}
            </select>
          </div>
          <div>
            <label htmlFor="saleType" className={labelClass}>Lead type</label>
            <select id="saleType" name="saleType" defaultValue="exclusive" className={inputClass}>
              <option value="exclusive">Exclusive</option>
              <option value="shared">Shared</option>
            </select>
          </div>
          <div>
            <label htmlFor="price" className={labelClass}>Price per lead (£)</label>
            <input id="price" name="price" inputMode="decimal" placeholder="35.00" required autoComplete="off" className={inputClass} />
          </div>
          <div className="flex items-end">
            <button type="submit" className={primaryButton}>Save price</button>
          </div>
        </form>
      </section>

      <section aria-labelledby="current-heading" className="mt-6">
        <h2 id="current-heading" className="text-xl font-bold text-ink">Current prices</h2>
        {current.length === 0 ? (
          <p className={`${cardClass} mt-2 text-muted`}>No prices set. Until one is, you will be asked for a price each time you hand a lead to a business.</p>
        ) : (
          <div className="relative mt-2 overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className="w-full min-w-[40rem] text-left">
              <caption className="sr-only">Current pricing rules</caption>
              <thead className="border-b border-stone-200 bg-stone-100 text-sm text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">Applies to</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Type</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Price</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Since</th>
                  <th scope="col" className="px-4 py-3 font-semibold"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200">
                {current.map((rule) => (
                  <tr key={rule.id}>
                    <td className="px-4 py-3">
                      {[rule.serviceLabel ?? "Any service", rule.areaName ?? "anywhere", rule.urgency ? URGENCIES[rule.urgency].label : "any urgency"].join(" · ")}
                      {rule.state === "future" && <span className="ml-2 text-sm text-muted">(starts later)</span>}
                    </td>
                    <td className="px-4 py-3 capitalize">{rule.saleType}</td>
                    <td className="px-4 py-3 font-semibold">{formatPence(rule.pricePence)}</td>
                    <td className="px-4 py-3 text-sm text-muted">{formatShort(rule.validFrom)}</td>
                    <td className="px-4 py-3">
                      <form action={endPriceAction}>
                        <input type="hidden" name="ruleId" value={rule.id} />
                        <button type="submit" className="font-semibold text-red-800 underline" aria-label={`End the ${formatPence(rule.pricePence)} price`}>End</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {ended.length > 0 && (
        <section aria-labelledby="history-heading" className="mt-6">
          <h2 id="history-heading" className="text-xl font-bold text-ink">Price history</h2>
          <ul className="mt-2 divide-y divide-stone-200 rounded-lg border border-stone-200 bg-white">
            {ended.map((rule) => (
              <li key={rule.id} className="px-4 py-2 text-sm text-muted">
                {formatPence(rule.pricePence)} · {[rule.serviceLabel ?? "any service", rule.areaName ?? "anywhere", rule.urgency ? URGENCIES[rule.urgency].label : "any urgency"].join(" · ")} · {rule.saleType} · {formatShort(rule.validFrom)}
                {rule.validTo ? ` to ${formatShort(rule.validTo)}` : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
