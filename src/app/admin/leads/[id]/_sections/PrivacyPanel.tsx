import { ERASE_REASONS } from "@/config/privacy";
import type { LeadWork } from "@/server/admin/assignments";
import { dangerButton, hintClass, inputClass, labelClass, secondaryButton } from "../../../_components/styles";
import { eraseLeadAction, withdrawConsentAction } from "../../actions";

interface Props {
  leadId: string;
  erased: boolean;
  withdrawn: boolean;
  work: LeadWork;
}

export function PrivacyPanel({ leadId, erased, withdrawn, work }: Props) {
  const isOwner = work.role === "owner";
  return (
    <section aria-labelledby="privacy-heading" className="mt-6 rounded-lg border border-stone-200 bg-white p-4 sm:p-6">
      <h2 id="privacy-heading" className="text-xl font-bold text-ink">Privacy</h2>

      {(erased || withdrawn) && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
          <p className="font-semibold">
            {erased ? "This person's data has been erased." : "This person withdrew consent."}
            {work.sentTo.length > 0 ? " Tell the businesses that were sent their details to stop using and delete them:" : " No business had been sent their details."}
          </p>
          {work.sentTo.length > 0 && (
            <ul className="mt-2 list-disc space-y-1 pl-6">
              {work.sentTo.map((client, index) => (
                <li key={index}>
                  <strong>{client.clientName}</strong>: {[client.contactName, client.contactPhone, client.contactEmail].filter(Boolean).join(" · ")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!erased && !withdrawn && (
        <form action={withdrawConsentAction} className="mt-3 space-y-2">
          <input type="hidden" name="leadId" value={leadId} />
          <h3 className="text-lg font-bold text-ink">The person asked us to stop</h3>
          <p className={hintClass}>
            Records that they withdrew consent, closes the lead, takes it back from any business holding it, and remembers (as an irreversible hash) not to hand their details to anyone. Their details stay until erased.
          </p>
          <button type="submit" className={secondaryButton}>They withdrew consent</button>
        </form>
      )}

      {!erased && (
        <div className="mt-6">
          <h3 className="text-lg font-bold text-ink">Erase personal data</h3>
          {isOwner ? (
            <form action={eraseLeadAction} className="mt-2 space-y-3">
              <input type="hidden" name="leadId" value={leadId} />
              <p className={hintClass}>
                <strong>Permanent.</strong> Blanks the name, phone, email, notes and full postcode, closes the lead and takes it back from any business. The consent record is kept as legal evidence.
              </p>
              <div>
                <label htmlFor="erase-reason" className={labelClass}>Why?</label>
                <select id="erase-reason" name="reason" required defaultValue="" className={inputClass}>
                  <option value="" disabled>Choose a reason</option>
                  {Object.entries(ERASE_REASONS).map(([code, text]) => (<option key={code} value={code}>{text}</option>))}
                </select>
              </div>
              <button type="submit" className={dangerButton}>Erase this person&rsquo;s data</button>
            </form>
          ) : (
            <p className="mt-1 text-muted">Only an owner can erase personal data. Ask an owner, or use &ldquo;They withdrew consent&rdquo; above to stop the lead being used.</p>
          )}
        </div>
      )}
    </section>
  );
}
