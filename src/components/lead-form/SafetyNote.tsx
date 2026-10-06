import { ELECTRICAL_EMERGENCY } from "@/config/safety";

const linkClass =
  "whitespace-nowrap rounded font-bold text-amber-900 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-300";

/**
 * "Fire, sparks or a shock? Call the emergency services, not us." Shown wherever someone with a dangerous problem might
 * otherwise wait for a quote (docs/00 E3).
 *
 * `compact` is the one-line version above the form: on a phone the first question must still be visible without scrolling
 * (paid traffic is mostly phones), so the full advice lives on the "when" question and in the FAQ.
 */
export function SafetyNote({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  const { phone, powerCut } = ELECTRICAL_EMERGENCY;
  if (compact) {
    return (
      <aside aria-label="Electrical safety" className={`rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-ink ring-1 ring-amber-300 ${className}`}>
        <p>
          <strong className="text-amber-900">{ELECTRICAL_EMERGENCY.headline}</strong> Don&apos;t wait for a quote: call{" "}
          <a href={`tel:${phone.tel}`} className={linkClass}>{phone.display}</a> for a fire or an injury, or{" "}
          <a href={`tel:${powerCut.tel}`} className={linkClass}>{powerCut.display}</a> for a power cut (free).
        </p>
      </aside>
    );
  }
  return (
    <aside aria-label="Electrical safety" className={`rounded-xl bg-amber-50 px-4 py-3 text-sm text-ink ring-1 ring-amber-300 ${className}`}>
      <p className="font-bold text-amber-900">{ELECTRICAL_EMERGENCY.headline}</p>
      <p className="mt-1">{ELECTRICAL_EMERGENCY.body}</p>
      <p className="mt-2">
        <a href={`tel:${phone.tel}`} className={linkClass}>Call {phone.display}</a>
      </p>
      <p className="mt-3 font-bold text-amber-900">{powerCut.label}</p>
      <p className="mt-1">{powerCut.body}</p>
      <p className="mt-2">
        <a href={`tel:${powerCut.tel}`} className={linkClass}>Call {powerCut.display}</a>
      </p>
    </aside>
  );
}
