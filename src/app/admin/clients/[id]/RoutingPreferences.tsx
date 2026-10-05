import { PAUSE_REASONS, WEEKDAYS } from "@/modules/clients/routing-schemas";
import type { PauseRow, RoutingPreferences as Prefs, WorkingWindowInput } from "@/modules/clients";
import { cardClass, dangerButton, hintClass, inputClass, labelClass, primaryButton, secondaryButton } from "../../_components/styles";
import { formatShort } from "../../_format";
import { addPauseAction, removePauseAction, saveRoutingPreferencesAction, saveWorkingHoursAction } from "../actions";

interface Props {
  clientId: string;
  prefs: Prefs;
  hours: WorkingWindowInput[];
  pauses: PauseRow[];
}

const STATE_TEXT: Record<PauseRow["state"], string> = { active: "Paused now", upcoming: "Upcoming", ended: "Ended" };

/** What this business asked for about automatic leads: how often, in what order, when, and when not. */
export function RoutingPreferences({ clientId, prefs, hours, pauses }: Props) {
  const byDay = new Map(hours.map((window) => [window.weekday, window]));
  const limited = hours.length > 0;

  return (
    <section id="routing" aria-labelledby="routing-prefs-heading" className={`${cardClass} mt-6`}>
      <h2 id="routing-prefs-heading" className="text-xl font-bold text-ink">Automatic leads</h2>
      <p className={`mt-1 max-w-3xl ${hintClass}`}>
        How the router treats this business when automatic routing is on. All times are this business&rsquo;s own ({prefs.timezone}). Leads you hand over by hand ignore all of this.
      </p>

      <form action={saveRoutingPreferencesAction} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <input type="hidden" name="clientId" value={clientId} />
        <div>
          <label htmlFor="priority" className={labelClass}>Priority</label>
          <input id="priority" name="priority" inputMode="numeric" autoComplete="off" defaultValue={String(prefs.priority)} aria-describedby="priority-hint" className={inputClass} />
          <p id="priority-hint" className={hintClass}>0 to 1000. A lower number is offered leads first.</p>
        </div>
        <div>
          <label htmlFor="weight" className={labelClass}>Weight</label>
          <input id="weight" name="weight" inputMode="numeric" autoComplete="off" defaultValue={String(prefs.weight)} aria-describedby="weight-hint" className={inputClass} />
          <p id="weight-hint" className={hintClass}>0 to 100. Among equals, 2 gets twice the leads of 1. <strong>0 = manual only</strong>: never routed automatically.</p>
        </div>
        <div>
          <label htmlFor="dailyLeadCap" className={labelClass}>Most leads a day</label>
          <input id="dailyLeadCap" name="dailyLeadCap" inputMode="numeric" autoComplete="off" defaultValue={prefs.dailyLeadCap === null ? "" : String(prefs.dailyLeadCap)} aria-describedby="daily-hint" className={inputClass} />
          <p id="daily-hint" className={hintClass}>Leave empty for no limit.</p>
        </div>
        <div>
          <label htmlFor="monthlyLeadCap" className={labelClass}>Most leads a month</label>
          <input id="monthlyLeadCap" name="monthlyLeadCap" inputMode="numeric" autoComplete="off" defaultValue={prefs.monthlyLeadCap === null ? "" : String(prefs.monthlyLeadCap)} aria-describedby="monthly-hint" className={inputClass} />
          <p id="monthly-hint" className={hintClass}>Leave empty for no limit.</p>
        </div>
        <div className="sm:col-span-2 lg:col-span-4">
          <button type="submit" className={primaryButton}>Save</button>
        </div>
      </form>

      <h3 className="mt-8 text-lg font-bold text-ink">Working hours</h3>
      <form action={saveWorkingHoursAction} className="mt-2 space-y-3">
        <input type="hidden" name="clientId" value={clientId} />
        <label className="flex items-start gap-3">
          <input type="checkbox" name="limitHours" defaultChecked={limited} className="mt-1 size-6" />
          <span>
            <span className="font-semibold">Only send leads during working hours</span>
            <span className={`block ${hintClass}`}>Unticked, the business can be sent a lead at any time. Ticked, leave a day empty to be closed on it.</span>
          </span>
        </label>
        <div className="overflow-x-auto rounded-lg border border-stone-200">
          <table className="w-full min-w-[26rem] text-left">
            <caption className="sr-only">Opening and closing time for each day</caption>
            <thead className="border-b border-stone-200 bg-stone-100 text-sm text-muted">
              <tr>
                <th scope="col" className="px-3 py-2 font-semibold">Day</th>
                <th scope="col" className="px-3 py-2 font-semibold">Opens</th>
                <th scope="col" className="px-3 py-2 font-semibold">Closes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-200">
              {WEEKDAYS.map(({ value, label }) => (
                <tr key={value}>
                  <th scope="row" className="px-3 py-2 font-semibold text-ink">{label}</th>
                  <td className="px-3 py-1">
                    <label htmlFor={`opens_${value}`} className="sr-only">{label} opens</label>
                    <input id={`opens_${value}`} name={`opens_${value}`} type="time" defaultValue={byDay.get(value)?.opens ?? ""} className={`${inputClass} !w-36`} />
                  </td>
                  <td className="px-3 py-1">
                    <label htmlFor={`closes_${value}`} className="sr-only">{label} closes</label>
                    <input id={`closes_${value}`} name={`closes_${value}`} type="time" defaultValue={byDay.get(value)?.closes ?? ""} className={`${inputClass} !w-36`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button type="submit" className={secondaryButton}>Save working hours</button>
      </form>

      <h3 className="mt-8 text-lg font-bold text-ink">Pauses</h3>
      <p className={`mt-1 ${hintClass}`}>A holiday or a full diary: no automatic leads while a pause covers the moment. (To stop leads altogether, change the status instead.)</p>
      {pauses.length === 0 ? (
        <p className="mt-2 text-muted">No pauses.</p>
      ) : (
        <ul className="mt-2 divide-y divide-stone-200 rounded-lg border border-stone-200">
          {pauses.map((pause) => (
            <li key={pause.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span>
                <strong>{STATE_TEXT[pause.state]}</strong>: {formatShort(pause.startsAt)} to {formatShort(pause.endsAt)} <span className={hintClass}>({PAUSE_REASONS[pause.reason as keyof typeof PAUSE_REASONS] ?? pause.reason})</span>
              </span>
              {pause.state !== "ended" && (
                <form action={removePauseAction}>
                  <input type="hidden" name="clientId" value={clientId} />
                  <input type="hidden" name="pauseId" value={pause.id} />
                  <button type="submit" className={dangerButton} aria-label={`Remove the pause ending ${formatShort(pause.endsAt)}`}>{pause.state === "active" ? "End it now" : "Remove"}</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <form action={addPauseAction} className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:items-end">
        <input type="hidden" name="clientId" value={clientId} />
        <div>
          <label htmlFor="pause-from" className={labelClass}>From</label>
          <input id="pause-from" name="from" type="datetime-local" className={inputClass} />
        </div>
        <div>
          <label htmlFor="pause-until" className={labelClass}>Until</label>
          <input id="pause-until" name="until" type="datetime-local" className={inputClass} />
        </div>
        <div>
          <label htmlFor="pause-reason" className={labelClass}>Why</label>
          <select id="pause-reason" name="reason" defaultValue="" className={inputClass}>
            <option value="" disabled>Choose a reason</option>
            {Object.entries(PAUSE_REASONS).map(([code, text]) => (<option key={code} value={code}>{text}</option>))}
          </select>
        </div>
        <div>
          <button type="submit" className={secondaryButton}>Add pause</button>
        </div>
      </form>
    </section>
  );
}
