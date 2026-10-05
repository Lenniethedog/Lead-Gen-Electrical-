import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CLIENT_STATUSES, CLIENT_STATUS_REASONS, MAX_RADIUS_MILES } from "@/modules/clients/schemas";
import { formatPence } from "@/modules/pricing/schemas";
import { loadClient, loadClientDelivery, loadClientRouting } from "@/server/admin/clients";
import { loadClientUsers } from "@/server/admin/users";
import { AssignmentStatusBadge, ClientStatusBadge } from "../../_components/Badges";
import { cardClass, hintClass, inputClass, labelClass, linkClass, primaryButton, secondaryButton } from "../../_components/styles";
import { ERRORS, NOTICES } from "../../_messages";
import { formatShort } from "../../_format";
import { ClientForm } from "../ClientForm";
import { ClientUsers } from "./ClientUsers";
import { DeliverySettings } from "./DeliverySettings";
import { RoutingPreferences } from "./RoutingPreferences";
import { addCoverageAction, changeServicesAction, changeStatusAction, removeCoverageAction, updateClientAction } from "../actions";

export const metadata: Metadata = { title: "Client" };

const RULE_KINDS = [
  { kind: "outward", title: "A postcode district", field: "outward", label: "District", placeholder: "BR6" },
  { kind: "sector", title: "A postcode sector", field: "sector", label: "Sector", placeholder: "BR6 0" },
  { kind: "postcode_prefix", title: "Postcodes starting with…", field: "postcodePrefix", label: "Starts with", placeholder: "BR6 0A" },
] as const;

export default async function ClientPage(props: PageProps<"/admin/clients/[id]">) {
  const [{ id }, query] = await Promise.all([props.params, props.searchParams]);
  const client = await loadClient(id);
  if (!client) notFound();
  const routing = await loadClientRouting(client.id);
  const delivery = await loadClientDelivery(client.id);
  const users = await loadClientUsers(client.id);

  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;
  const error = typeof query.error === "string" ? (typeof query.detail === "string" && query.error === "invalid_request" ? query.detail : ERRORS[query.error]) : undefined;
  const offered = new Set(client.services.map((service) => service.slug));
  const initial: Record<string, string> = {
    name: client.name,
    legalName: client.legalName ?? "",
    companyNumber: client.companyNumber ?? "",
    contactName: client.contactName ?? "",
    contactEmail: client.contactEmail,
    contactPhone: client.contactPhone ?? "",
    notes: client.notes ?? "",
    ...(client.acceptsExclusive && { acceptsExclusive: "on" }),
    ...(client.acceptsShared && { acceptsShared: "on" }),
  };

  return (
    <>
      <p>
        <Link href="/admin/clients" className={linkClass}>
          &larr; All clients
        </Link>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-extrabold text-ink">{client.name}</h1>
        <ClientStatusBadge status={client.status} />
      </div>
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

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="status-heading" className={cardClass}>
          <h2 id="status-heading" className="text-xl font-bold text-ink">Status</h2>
          <p className={`mt-1 ${hintClass}`}>
            Only <strong>active</strong> clients are offered leads. To activate, the client needs at least one service and one &ldquo;include&rdquo; coverage rule. Pausing, suspending or ending needs a reason.
          </p>
          <form action={changeStatusAction} className="mt-4 space-y-3">
            <input type="hidden" name="clientId" value={client.id} />
            <div>
              <label htmlFor="status" className={labelClass}>Change to</label>
              <select id="status" name="status" defaultValue={client.status} className={inputClass}>
                {CLIENT_STATUSES.map((status) => (
                  <option key={status} value={status}>{status[0]!.toUpperCase() + status.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="reason" className={labelClass}>Reason <span className={hintClass}>(needed to pause, suspend or end)</span></label>
              <select id="reason" name="reason" defaultValue="" className={inputClass}>
                <option value="">No reason</option>
                {Object.entries(CLIENT_STATUS_REASONS).map(([code, text]) => (
                  <option key={code} value={code}>{text}</option>
                ))}
              </select>
            </div>
            <button type="submit" className={primaryButton}>Change status</button>
          </form>
        </section>

        <section aria-labelledby="services-heading" className={cardClass}>
          <h2 id="services-heading" className="text-xl font-bold text-ink">What they do</h2>
          <form action={changeServicesAction} className="mt-3 space-y-2">
            <input type="hidden" name="clientId" value={client.id} />
            {client.allServices.map((service) => (
              <label key={service.slug} className="flex min-h-12 items-center gap-3 text-lg">
                <input type="checkbox" name="serviceSlug" value={service.slug} defaultChecked={offered.has(service.slug)} className="size-6" />
                {service.label}
              </label>
            ))}
            <button type="submit" className={`${secondaryButton} mt-2`}>Save services</button>
          </form>
        </section>
      </div>

      <section aria-labelledby="coverage-heading" className={`${cardClass} mt-6`}>
        <h2 id="coverage-heading" className="text-xl font-bold text-ink">Where they cover</h2>
        <p className={`mt-1 ${hintClass}`}>
          A lead is eligible if <strong>any include rule matches</strong> its postcode and <strong>no exclude rule does</strong>. Check the result in the{" "}
          <Link href="/admin/coverage" className={linkClass}>coverage tester</Link>.
        </p>
        {client.rules.length === 0 ? (
          <p className="mt-3 text-muted">No coverage rules yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-200 rounded-lg border border-stone-200">
            {client.rules.map((rule) => (
              <li key={rule.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span>
                  <span className={`mr-2 inline-flex rounded-full px-2.5 py-0.5 text-sm font-semibold ${rule.mode === "include" ? "bg-green-100 text-green-900" : "bg-red-100 text-red-900"}`}>
                    {rule.mode === "include" ? "Include" : "Exclude"}
                  </span>
                  {rule.label}
                </span>
                <form action={removeCoverageAction}>
                  <input type="hidden" name="clientId" value={client.id} />
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <button type="submit" className="font-semibold text-red-800 underline" aria-label={`Remove rule: ${rule.label}`}>Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mt-6 text-lg font-bold text-ink">Add a rule</h3>
        <div className="mt-2 grid gap-4 lg:grid-cols-2">
          {RULE_KINDS.map((spec) => (
            <form key={spec.kind} action={addCoverageAction} className="space-y-2 rounded-lg border border-stone-200 p-3">
              <input type="hidden" name="clientId" value={client.id} />
              <input type="hidden" name="kind" value={spec.kind} />
              <p className="font-semibold text-ink">{spec.title}</p>
              <div className="grid grid-cols-[8rem_1fr] gap-2">
                <select name="mode" aria-label={`${spec.title}: include or exclude`} className={inputClass} defaultValue="include">
                  <option value="include">Include</option>
                  <option value="exclude">Exclude</option>
                </select>
                <input name={spec.field} aria-label={`${spec.title}: ${spec.label}`} placeholder={spec.placeholder} required autoComplete="off" className={inputClass} />
              </div>
              <button type="submit" className={secondaryButton}>Add</button>
            </form>
          ))}
          <form action={addCoverageAction} className="space-y-2 rounded-lg border border-stone-200 p-3">
            <input type="hidden" name="clientId" value={client.id} />
            <input type="hidden" name="kind" value="area" />
            <p className="font-semibold text-ink">A named area</p>
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <select name="mode" aria-label="Named area: include or exclude" className={inputClass} defaultValue="include">
                <option value="include">Include</option>
                <option value="exclude">Exclude</option>
              </select>
              <select name="serviceAreaSlug" aria-label="Named area: area" required defaultValue="" className={inputClass}>
                <option value="" disabled>Choose an area</option>
                {client.allAreas.map((area) => (
                  <option key={area.slug} value={area.slug}>{area.name}</option>
                ))}
              </select>
            </div>
            <button type="submit" className={secondaryButton}>Add</button>
          </form>
          <form action={addCoverageAction} className="space-y-2 rounded-lg border border-stone-200 p-3">
            <input type="hidden" name="clientId" value={client.id} />
            <input type="hidden" name="kind" value="radius" />
            <p className="font-semibold text-ink">Within a distance of a postcode</p>
            <div className="grid grid-cols-[8rem_1fr] gap-2">
              <select name="mode" aria-label="Radius: include or exclude" className={inputClass} defaultValue="include">
                <option value="include">Include</option>
                <option value="exclude">Exclude</option>
              </select>
              <input name="centerPostcode" aria-label="Radius: centre postcode" placeholder="BR6 0AA" required autoComplete="off" className={inputClass} />
            </div>
            <label className="block text-sm font-semibold" htmlFor="radiusMiles">Miles (1 to {MAX_RADIUS_MILES})</label>
            <input id="radiusMiles" name="radiusMiles" inputMode="decimal" placeholder="10" required autoComplete="off" className={inputClass} />
            <button type="submit" className={secondaryButton}>Add</button>
          </form>
        </div>
      </section>

      <ClientUsers clientId={client.id} users={users} />

      {delivery && <DeliverySettings clientId={client.id} settings={delivery.settings} secretsAvailable={delivery.secretsAvailable} />}

      {routing && <RoutingPreferences clientId={client.id} prefs={routing.prefs} hours={routing.hours} pauses={routing.pauses} />}

      <section aria-labelledby="details-heading" className={`${cardClass} mt-6`}>
        <h2 id="details-heading" className="text-xl font-bold text-ink">Details</h2>
        <div className="mt-4">
          <ClientForm action={updateClientAction.bind(null, client.id)} initial={initial} submitLabel="Save details" />
        </div>
      </section>

      <section aria-labelledby="held-heading" className={`${cardClass} mt-6`}>
        <h2 id="held-heading" className="text-xl font-bold text-ink">Leads handed to them</h2>
        {client.assignments.length === 0 ? (
          <p className="mt-2 text-muted">None yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-stone-200">
            {client.assignments.map((assignment) => (
              <li key={assignment.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                <Link href={`/admin/leads/${assignment.leadId}`} className={`font-mono ${linkClass}`}>{assignment.reference}</Link>
                <AssignmentStatusBadge status={assignment.status} />
                <span className="text-muted">{formatPence(assignment.pricePence)}</span>
                <span className="text-sm text-muted">{formatShort(assignment.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
