import type { DeliverySettings as Settings } from "@/modules/clients";
import { cardClass, hintClass, inputClass, labelClass, primaryButton } from "../../_components/styles";
import { formatShort } from "../../_format";
import { saveDeliveryAction } from "../actions";
import { WebhookSecret } from "./WebhookSecret";

/** How this business is told about its leads. Manual is how it has worked since stage 3 (an operator sends it); automatic sends on every channel ticked, as soon as the lead is assigned. */
export function DeliverySettings({ clientId, settings, secretsAvailable }: { clientId: string; settings: Settings; secretsAvailable: boolean }) {
  return (
    <section id="delivery" aria-labelledby="delivery-heading" className={`${cardClass} mt-6`}>
      <h2 id="delivery-heading" className="text-xl font-bold text-ink">How they are told</h2>
      <p className={`mt-1 max-w-3xl ${hintClass}`}>
        <strong>Manual</strong>: you copy the message and press &ldquo;I&rsquo;ve sent it&rdquo; on the lead. <strong>Automatic</strong>: the moment a lead is assigned (by you or by routing) it is sent on every way ticked below, retried if it fails, and if none of them can be
        reached the lead is taken back and routed to someone else. Switch to automatic only after a test lead has reached them.
      </p>
      {settings.failingSince && <p role="status" className="mt-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950">Their webhook has been failing since {formatShort(settings.failingSince)}.</p>}

      <form action={saveDeliveryAction} className="mt-4 space-y-4">
        <input type="hidden" name="clientId" value={clientId} />
        <div>
          <label htmlFor="deliveryMode" className={labelClass}>Delivery</label>
          <select id="deliveryMode" name="deliveryMode" defaultValue={settings.mode} className={`${inputClass} !w-auto`}>
            <option value="manual">Manual: I send it</option>
            <option value="automatic">Automatic</option>
          </select>
          {settings.mode === "automatic" && settings.enabledAt && <p className={hintClass}>Automatic since {formatShort(settings.enabledAt)}.</p>}
        </div>
        <fieldset className="space-y-2">
          <legend className={labelClass}>Tell them by</legend>
          <label className="flex min-h-12 items-start gap-3">
            <input type="checkbox" name="notifyEmail" defaultChecked={settings.email} className="mt-1 size-6" />
            <span>
              <span className="font-semibold">Email</span>
              <span className={`block ${hintClass}`}>The full details, to {settings.contactEmail}.</span>
            </span>
          </label>
          <label className="flex min-h-12 items-start gap-3">
            <input type="checkbox" name="notifySms" defaultChecked={settings.sms} className="mt-1 size-6" />
            <span>
              <span className="font-semibold">Text message</span>
              <span className={`block ${hintClass}`}>First name, phone number, area and job only, to {settings.contactPhone ?? "(add a phone number to their details first)"}. A text is not a secure channel.</span>
            </span>
          </label>
          <label className="flex min-h-12 items-start gap-3">
            <input type="checkbox" name="notifyWebhook" defaultChecked={settings.webhook} className="mt-1 size-6" />
            <span>
              <span className="font-semibold">Webhook</span>
              <span className={`block ${hintClass}`}>The full record, signed, to their own system over https. Generate a signing secret first.</span>
            </span>
          </label>
        </fieldset>
        <div>
          <label htmlFor="webhookUrl" className={labelClass}>Webhook address</label>
          <input id="webhookUrl" name="webhookUrl" type="url" defaultValue={settings.webhookUrl ?? ""} placeholder="https://crm.theirbusiness.co.uk/hooks/leads" autoComplete="off" aria-describedby="webhook-hint" className={inputClass} />
          <p id="webhook-hint" className={hintClass}>Must start with https:// and be on the public internet. Private addresses are refused.</p>
        </div>
        <button type="submit" className={primaryButton}>Save how they are told</button>
      </form>

      <h3 className="mt-6 text-lg font-bold text-ink">Webhook signing secret</h3>
      <div className="mt-2">
        <WebhookSecret clientId={clientId} hint={settings.secretHint} available={secretsAvailable} />
      </div>
    </section>
  );
}
