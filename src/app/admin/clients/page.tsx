import type { Metadata } from "next";
import Link from "next/link";
import { loadClients } from "@/server/admin/clients";
import { ClientStatusBadge } from "../_components/Badges";
import { cardClass, linkClass, primaryButton } from "../_components/styles";
import { NOTICES } from "../_messages";

export const metadata: Metadata = { title: "Clients" };

export default async function ClientsPage(props: PageProps<"/admin/clients">) {
  const [{ clients }, query] = await Promise.all([loadClients(), props.searchParams]);
  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-extrabold text-ink">Clients</h1>
        <Link href="/admin/clients/new" className={primaryButton}>
          New client
        </Link>
      </div>
      {notice && (
        <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">
          {notice}
        </p>
      )}
      <p className="mt-3 text-sm text-muted">
        The businesses that buy leads. A client must be <strong>active</strong>, offer the service and cover the postcode to be offered a lead. Try a postcode in the{" "}
        <Link href="/admin/coverage" className={linkClass}>
          coverage tester
        </Link>
        .
      </p>

      {clients.length === 0 ? (
        <p className={`${cardClass} mt-6 text-center text-muted`}>No clients yet. Add the first business you will send leads to.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[40rem] text-left">
            <caption className="sr-only">Clients</caption>
            <thead className="border-b border-stone-200 bg-stone-100 text-sm text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">Business</th>
                <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                <th scope="col" className="px-4 py-3 font-semibold">Services</th>
                <th scope="col" className="px-4 py-3 font-semibold">Coverage rules</th>
                <th scope="col" className="px-4 py-3 font-semibold">Leads held</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200">
              {clients.map((client) => (
                <tr key={client.id}>
                  <td className="px-4 py-3">
                    <Link href={`/admin/clients/${client.id}`} className={linkClass}>
                      {client.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <ClientStatusBadge status={client.status} />
                  </td>
                  <td className="px-4 py-3">{client.services}</td>
                  <td className="px-4 py-3">{client.includeRules}</td>
                  <td className="px-4 py-3">{client.activeLeads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
