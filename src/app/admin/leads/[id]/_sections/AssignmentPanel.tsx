import { CANCEL_REASONS } from "@/config/assignment";
import { CHANNEL_LABEL } from "@/config/delivery";
import type { LeadWork } from "@/server/admin/assignments";
import { formatPence } from "@/modules/pricing/schemas";
import { AssignmentStatusBadge } from "../../../_components/Badges";
import { dangerButton, hintClass, inputClass, labelClass, primaryButton, secondaryButton } from "../../../_components/styles";
import { formatFull } from "../../../_format";
import { retryDeliveryAction } from "../../../deliveries/actions";
import { assignLeadAction, cancelAssignmentAction, markSentAction, reassignAction } from "../../actions";
import { CopyBox } from "./CopyBox";

interface Props {
  leadId: string;
  /** The lead can be handed to someone now (new, not erased, consent not withdrawn). */
  canAssign: boolean;
  work: LeadWork;
}

function ClientChoice({ candidates, exclude }: { candidates: NonNullable<LeadWork["candidates"]>; exclude?: Set<string> }) {
  const visible = candidates.clients.filter((client) => !exclude?.has(client.clientId));
  return (
    <>
      {visible.map((client) => (
        <option key={client.clientId} value={client.clientId}>
          {client.name}
          {client.eligible ? " (covers this postcode)" : " (outside coverage)"}
        </option>
      ))}
    </>
  );
}

function PriceField({ candidates, id }: { candidates: NonNullable<LeadWork["candidates"]>; id: string }) {
  if (candidates.price) {
    return <p className={hintClass}>Price: <strong>{formatPence(candidates.price.pricePence)}</strong> (from the pricing rules)</p>;
  }
  return (
    <div>
      <label htmlFor={id} className={labelClass}>Price for this lead (£)</label>
      <p className={hintClass}>No pricing rule matches this lead, so enter it here. (Set prices on the Pricing page to stop being asked.)</p>
      <input id={id} name="price" inputMode="decimal" placeholder="35.00" required autoComplete="off" className={inputClass} />
    </div>
  );
}

const DELIVERY_TEXT: Record<string, string> = {
  pending: "Waiting to be sent",
  sending: "Sending",
  retrying: "Failed, trying again",
  sent: "Sent",
  delivered: "Delivered",
  failed: "Failed",
  dead: "Gave up",
  cancelled: "Not sent (the lead was taken back)",
};

export function AssignmentPanel({ leadId, canAssign, work }: Props) {
  const { candidates, assignments, handovers } = work;
  const active = assignments.filter((assignment) => assignment.active);
  const heldBy = new Set(active.map((assignment) => assignment.clientId));

  return (
    <section aria-labelledby="assign-heading" className="mt-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
      <h2 id="assign-heading" className="text-xl font-bold text-ink">Businesses</h2>

      {canAssign && candidates && (
        <form action={assignLeadAction} className="mt-3 space-y-3 rounded-lg border-2 border-brand-300 bg-brand-50 p-4">
          <input type="hidden" name="leadId" value={leadId} />
          <h3 className="text-lg font-bold text-ink">Hand this lead to a business</h3>
          {candidates.clients.length === 0 ? (
            <p className="text-muted">No active clients yet. Add one and make them active on the Clients page.</p>
          ) : (
            <>
              <div>
                <label htmlFor="assign-client" className={labelClass}>Business</label>
                <select id="assign-client" name="clientId" required defaultValue="" className={inputClass}>
                  <option value="" disabled>Choose a business</option>
                  <ClientChoice candidates={candidates} />
                </select>
              </div>
              <label className="flex items-start gap-3">
                <input type="checkbox" name="coverageException" className="mt-1 size-6" />
                <span>
                  <span className="font-semibold">Hand it over even though they don&rsquo;t cover this postcode</span>
                  <span className={`block ${hintClass}`}>Only tick this if you know they will take it. It is recorded.</span>
                </span>
              </label>
              <PriceField candidates={candidates} id="assign-price" />
              <button type="submit" className={primaryButton}>Assign lead</button>
            </>
          )}
        </form>
      )}

      {assignments.length === 0 ? (
        !canAssign && <p className="mt-2 text-muted">This lead has not been handed to a business.</p>
      ) : (
        <ul className="mt-4 space-y-5">
          {assignments.map((assignment) => {
            const message = handovers[assignment.id];
            const deliveries = work.deliveries.filter((delivery) => delivery.assignmentId === assignment.id);
            return (
              <li key={assignment.id} className="rounded-lg border border-stone-200 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-bold text-ink">{assignment.clientName}</h3>
                  <AssignmentStatusBadge status={assignment.status} />
                  <span className="text-muted">{formatPence(assignment.pricePence)}</span>
                </div>
                {assignment.active && (
                  <p className={`mt-1 ${hintClass}`}>
                    {[assignment.clientContactName, assignment.clientContactPhone, assignment.clientContactEmail].filter(Boolean).join(" · ")}
                  </p>
                )}

                {assignment.active && message && (
                  <div className="mt-4 space-y-4">
                    <CopyBox text={message.text} label={`Message for ${assignment.clientName} (send it to ${message.to})`} />
                    {deliveries.length > 0 && (
                      <div id="delivery">
                        <h4 className="font-semibold text-ink">Sent automatically</h4>
                        <ul className="mt-1 space-y-1">
                          {deliveries.map((delivery) => (
                            <li key={delivery.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                              <span className="font-semibold">{CHANNEL_LABEL[delivery.channel]}</span>
                              <span>{DELIVERY_TEXT[delivery.status] ?? delivery.status}</span>
                              {delivery.lastErrorCode && delivery.status !== "sent" && delivery.status !== "delivered" && <span className={hintClass}>({delivery.lastErrorCode.replace(/_/g, " ")})</span>}
                              {(delivery.status === "failed" || delivery.status === "dead") && (
                                <form action={retryDeliveryAction}>
                                  <input type="hidden" name="notificationId" value={delivery.id} />
                                  <input type="hidden" name="leadId" value={leadId} />
                                  <input type="hidden" name="returnTo" value="lead" />
                                  <button type="submit" className="font-semibold text-brand-800 underline" aria-label={`Try the ${CHANNEL_LABEL[delivery.channel]} again`}>Try again</button>
                                </form>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {assignment.status === "reserved" && (
                      deliveries.some((delivery) => ["pending", "sending", "retrying"].includes(delivery.status)) ? (
                        <details className="rounded-lg border border-stone-200 p-3">
                          <summary className="cursor-pointer font-semibold text-ink">Send it yourself instead</summary>
                          <p className={`mt-2 ${hintClass}`}>It is being sent automatically. Only do this if you have already sent it, or it is urgent and the automatic delivery is stuck.</p>
                          <form action={markSentAction} className="mt-3">
                            <input type="hidden" name="leadId" value={leadId} />
                            <input type="hidden" name="assignmentId" value={assignment.id} />
                            <button type="submit" className={primaryButton}>I&rsquo;ve sent it</button>
                          </form>
                        </details>
                      ) : (
                        <form action={markSentAction}>
                          <input type="hidden" name="leadId" value={leadId} />
                          <input type="hidden" name="assignmentId" value={assignment.id} />
                          <button type="submit" className={primaryButton}>I&rsquo;ve sent it</button>
                        </form>
                      )
                    )}

                    <details className="rounded-lg border border-stone-200 p-3">
                      <summary className="cursor-pointer font-semibold text-ink">Take it back</summary>
                      <form action={cancelAssignmentAction} className="mt-3 space-y-3">
                        <input type="hidden" name="leadId" value={leadId} />
                        <input type="hidden" name="assignmentId" value={assignment.id} />
                        <div>
                          <label htmlFor={`cancel-${assignment.id}`} className={labelClass}>Why?</label>
                          <select id={`cancel-${assignment.id}`} name="reason" required defaultValue="" className={inputClass}>
                            <option value="" disabled>Choose a reason</option>
                            {Object.entries(CANCEL_REASONS).map(([code, text]) => (<option key={code} value={code}>{text}</option>))}
                          </select>
                        </div>
                        <button type="submit" className={dangerButton}>Take it back</button>
                      </form>
                    </details>

                    {candidates && candidates.clients.some((client) => !heldBy.has(client.clientId)) && (
                      <details className="rounded-lg border border-stone-200 p-3">
                        <summary className="cursor-pointer font-semibold text-ink">Move it to another business</summary>
                        <form action={reassignAction} className="mt-3 space-y-3">
                          <input type="hidden" name="leadId" value={leadId} />
                          <input type="hidden" name="assignmentId" value={assignment.id} />
                          <div>
                            <label htmlFor={`move-to-${assignment.id}`} className={labelClass}>Move to</label>
                            <select id={`move-to-${assignment.id}`} name="toClientId" required defaultValue="" className={inputClass}>
                              <option value="" disabled>Choose a business</option>
                              <ClientChoice candidates={candidates} exclude={heldBy} />
                            </select>
                          </div>
                          <div>
                            <label htmlFor={`move-why-${assignment.id}`} className={labelClass}>Why move it?</label>
                            <select id={`move-why-${assignment.id}`} name="reason" required defaultValue="" className={inputClass}>
                              <option value="" disabled>Choose a reason</option>
                              {Object.entries(CANCEL_REASONS).map(([code, text]) => (<option key={code} value={code}>{text}</option>))}
                            </select>
                          </div>
                          <label className="flex items-start gap-3">
                            <input type="checkbox" name="coverageException" className="mt-1 size-6" />
                            <span className="font-semibold">Even if they don&rsquo;t cover this postcode</span>
                          </label>
                          <PriceField candidates={candidates} id={`move-price-${assignment.id}`} />
                          <button type="submit" className={secondaryButton}>Move lead</button>
                        </form>
                      </details>
                    )}
                  </div>
                )}

                <details className="mt-3">
                  <summary className="cursor-pointer text-sm font-semibold text-muted">History</summary>
                  <ol className="mt-2 space-y-1 text-sm">
                    {assignment.history.map((entry, index) => (
                      <li key={index}>
                        <span className="text-muted">{formatFull(entry.at)}</span> · {entry.from ? `${entry.from} → ` : ""}<strong>{entry.to}</strong>{entry.reason ? ` (${entry.reason})` : ""} <span className="text-muted">— {entry.actor}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
