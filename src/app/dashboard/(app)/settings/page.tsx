import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadNotificationPage } from "@/server/client/portal";
import { cardClass, hintClass, inputClass, labelClass, primaryButton } from "../../../admin/_components/styles";
import { saveSettingsAction } from "./actions";

export const metadata: Metadata = { title: "How you are told" };

const ERRORS: Record<string, string> = {
  invalid_email: "Enter a valid email address.",
  invalid_phone: "Enter a UK mobile number like 07123 456789 (and add one to get text messages).",
  forbidden: "Only the owner can change where leads are sent.",
  no_channel: "Keep at least one way on: otherwise you would not be told about new leads.",
  unchanged: "Nothing was different, so nothing was changed.",
  not_found: "Your account could not be found.",
};

export default async function SettingsPage(props: PageProps<"/dashboard/settings">) {
  const [page, query] = await Promise.all([loadNotificationPage(), props.searchParams]);
  if (!page) notFound();
  const { settings, canChangeAddress } = page;
  const error = typeof query.error === "string" ? ERRORS[query.error] : undefined;

  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">How you are told about new leads</h1>
      <p className="mt-1 max-w-3xl text-muted">The moment a lead is sent to you, we tell you here. Changes apply to the next lead. Leads carry a person&rsquo;s details, so {canChangeAddress ? "check the address and number carefully." : "only the owner can change where they are sent."}</p>
      {query.notice === "saved" && <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">Saved. It applies to the next lead.</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">{error}</p>}

      <form action={saveSettingsAction} className={`${cardClass} mt-4 space-y-5`}>
        <fieldset className="space-y-2">
          <legend className={labelClass}>Tell me by</legend>
          <label className="flex min-h-12 items-start gap-3">
            <input type="checkbox" name="notifyEmail" defaultChecked={settings.email} className="mt-1 size-6" />
            <span><span className="font-semibold">Email</span><span className={`block ${hintClass}`}>The full details.</span></span>
          </label>
          <label className="flex min-h-12 items-start gap-3">
            <input type="checkbox" name="notifySms" defaultChecked={settings.sms} className="mt-1 size-6" />
            <span><span className="font-semibold">Text message</span><span className={`block ${hintClass}`}>First name, phone number, area and job. A text is not a secure channel.</span></span>
          </label>
          {settings.webhook && <p className={hintClass}>We also send each lead to your own system (set up with us). Ask us to change that.</p>}
        </fieldset>

        {canChangeAddress ? (
          <>
            <div>
              <label htmlFor="contactEmail" className={labelClass}>Email address for leads</label>
              <input id="contactEmail" name="contactEmail" type="email" required defaultValue={settings.contactEmail} autoComplete="off" className={inputClass} />
            </div>
            <div>
              <label htmlFor="contactPhone" className={labelClass}>Mobile number for texts</label>
              <input id="contactPhone" name="contactPhone" type="tel" inputMode="tel" defaultValue={settings.contactPhone ?? ""} autoComplete="off" aria-describedby="phone-hint" className={inputClass} />
              <p id="phone-hint" className={hintClass}>A UK mobile. Leave empty if you do not want texts.</p>
            </div>
          </>
        ) : (
          <div>
            <input type="hidden" name="contactEmail" value={settings.contactEmail} />
            <input type="hidden" name="contactPhone" value={settings.contactPhone ?? ""} />
            <p className="font-semibold">Leads are sent to</p>
            <p>{settings.contactEmail}{settings.contactPhone ? ` and ${settings.contactPhone}` : ""}</p>
            <p className={hintClass}>Only the owner can change where leads are sent.</p>
          </div>
        )}
        <button type="submit" className={primaryButton}>Save</button>
      </form>
    </>
  );
}
