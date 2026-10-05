import type { Metadata } from "next";
import Link from "next/link";
import { CHANNEL_LABEL } from "@/config/delivery";
import { loadDeliveryProblems } from "@/server/admin/delivery";
import { dangerButton, hintClass, linkClass, secondaryButton } from "../_components/styles";
import { formatShort } from "../_format";
import { ERRORS, NOTICES } from "../_messages";
import { retryDeliveryAction } from "./actions";

export const metadata: Metadata = { title: "Deliveries" };

/** Plain words for the codes a delivery can fail with. Anything else is shown as the code. */
const FAILURE_TEXT: Record<string, string> = {
  twilio_21211: "That is not a valid mobile number",
  twilio_21610: "That number has opted out of texts",
  twilio_21614: "That number cannot receive texts",
  twilio_30003: "The phone was unreachable or switched off",
  twilio_30005: "The number is unknown",
  twilio_30006: "A landline or an unreachable carrier",
  validation_error: "The email address or sender was rejected",
  http_404: "Their webhook address was not found",
  http_410: "Their webhook address has gone",
  http_401: "Their system rejected the signature or login",
  http_403: "Their system refused the request",
  destination_not_public: "The webhook address points at a private address",
  channel_not_configured: "This kind of delivery is not set up on the server",
  secret_unreadable: "The webhook signing secret cannot be read (the encryption key may have changed)",
  lease_expired: "The worker stopped part-way: retried until attempts ran out",
};

export default async function DeliveriesPage(props: PageProps<"/admin/deliveries">) {
  const [problems, query] = await Promise.all([loadDeliveryProblems(), props.searchParams]);
  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;

  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Deliveries that need you</h1>
      <p className="mt-2 max-w-3xl text-muted">
        Leads sent automatically to a business that did not go through, from the last three days. A failure on one way (a text) when another way (the email) went out is shown here too, because nobody has confirmed they were reached.
        Try again if the cause is fixed, or open the lead to take it back or move it. When <em>every</em> way fails the lead is taken back and routed again by itself; you do not need to do anything.
      </p>
      {notice && <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">{error}</p>}

      {problems.length === 0 ? (
        <p className="mt-8 rounded-lg border border-stone-200 bg-white px-4 py-8 text-center text-muted">Nothing needs doing: every delivery went through.</p>
      ) : (
        <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[46rem] text-left">
            <caption className="sr-only">Failed deliveries, newest first</caption>
            <thead className="border-b border-stone-200 bg-stone-100 text-sm text-muted">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">When</th>
                <th scope="col" className="px-4 py-3 font-semibold">Lead</th>
                <th scope="col" className="px-4 py-3 font-semibold">Business</th>
                <th scope="col" className="px-4 py-3 font-semibold">Way</th>
                <th scope="col" className="px-4 py-3 font-semibold">What went wrong</th>
                <th scope="col" className="px-4 py-3 font-semibold"><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200">
              {problems.map((problem) => {
                const active = ["reserved", "notified"].includes(problem.assignmentStatus);
                return (
                  <tr key={problem.id}>
                    <td className="px-4 py-3 align-top text-sm text-muted">{formatShort(problem.nextAttemptAt)}</td>
                    <td className="px-4 py-3 align-top"><Link href={`/admin/leads/${problem.leadId}#delivery`} className={`${linkClass} font-mono`}>{problem.reference}</Link></td>
                    <td className="px-4 py-3 align-top">{problem.clientName}</td>
                    <td className="px-4 py-3 align-top">{CHANNEL_LABEL[problem.channel]}</td>
                    <td className="px-4 py-3 align-top">
                      {FAILURE_TEXT[problem.lastErrorCode ?? ""] ?? problem.lastErrorCode ?? "Unknown"}
                      <span className={`block ${hintClass}`}>{problem.status === "dead" ? `Gave up after ${problem.attempts} tries.` : "Rejected."}{!active && " The lead was taken back from this business."}</span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      {active ? (
                        <form action={retryDeliveryAction}>
                          <input type="hidden" name="notificationId" value={problem.id} />
                          <button type="submit" className={problem.channel === "email" ? dangerButton : secondaryButton} aria-label={`Try again: ${CHANNEL_LABEL[problem.channel]} to ${problem.clientName} for ${problem.reference}`}>Try again</button>
                        </form>
                      ) : <span className={hintClass}>–</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
