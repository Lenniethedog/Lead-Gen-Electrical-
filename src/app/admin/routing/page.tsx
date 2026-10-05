import type { Metadata } from "next";
import Link from "next/link";
import { formatPence } from "@/modules/pricing/schemas";
import { RULE_INFO } from "@/modules/routing/rules";
import type { RunDetail } from "@/modules/routing";
import { loadRouting } from "@/server/admin/routing";
import { RunOutcomeBadge, runReasonText } from "../_components/RoutingParts";
import { cardClass, dangerButton, hintClass, inputClass, labelClass, linkClass, primaryButton, secondaryButton } from "../_components/styles";
import { formatFull, formatShort } from "../_format";
import { ERRORS, NOTICES } from "../_messages";
import { moveRuleAction, saveMaxAgeAction, saveRuleAction, setRoutingEnabledAction } from "./actions";

export const metadata: Metadata = { title: "Routing" };

const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)} ms`);

export default async function RoutingPage(props: PageProps<"/admin/routing">) {
  const [data, query] = await Promise.all([loadRouting(), props.searchParams]);
  const { settings, rules, stats, runs } = data;
  const owner = data.role === "owner";
  const notice = typeof query.notice === "string" ? NOTICES[query.notice] : undefined;
  const error = typeof query.error === "string" ? (typeof query.detail === "string" && query.detail !== "" ? query.detail : ERRORS[query.error]) : undefined;
  const rankers = rules.filter((rule) => rule.kind === "ranker");

  return (
    <>
      <h1 className="text-2xl font-extrabold text-ink">Routing</h1>
      <p className="mt-2 max-w-3xl text-muted">
        Who gets a lead without anyone choosing. The router hands each new lead to one business, by the rules below, and records exactly why. It does <strong>not</strong> send the lead or charge anyone:
        you still copy the message and press &ldquo;I&rsquo;ve sent it&rdquo; on the lead.
      </p>
      {notice && <p role="status" className="mt-4 rounded-lg border border-green-300 bg-green-50 px-4 py-3 text-green-900">{notice}</p>}
      {error && <p role="alert" className="mt-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-red-900">{error}</p>}

      <section aria-labelledby="switch-heading" className={`${cardClass} mt-6`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="switch-heading" className="text-xl font-bold text-ink">Automatic routing</h2>
          <span className={`inline-flex rounded-full px-3 py-1 text-base font-bold ${settings.enabled ? "bg-green-100 text-green-900" : "bg-stone-200 text-stone-800"}`}>{settings.enabled ? "On" : "Off"}</span>
        </div>
        {settings.enabled && settings.enabledAt && <p className={`mt-1 ${hintClass}`}>On since {formatFull(settings.enabledAt)}. Only leads that arrived after that are routed automatically; older ones are left for you.</p>}
        {!settings.enabled && <p className={`mt-1 ${hintClass}`}>Nothing is routed automatically. Leads wait for you in <Link href="/admin/leads" className={linkClass}>Needs action</Link>, as before.</p>}

        {owner ? (
          settings.enabled ? (
            <form action={setRoutingEnabledAction} className="mt-4">
              <input type="hidden" name="enabled" value="false" />
              <button type="submit" className={dangerButton}>Switch routing off</button>
              <p className={`mt-2 ${hintClass}`}>Leads already assigned stay assigned. New leads wait for you again.</p>
            </form>
          ) : (
            <form action={setRoutingEnabledAction} className="mt-4 space-y-3">
              <input type="hidden" name="enabled" value="true" />
              <ul className="list-disc space-y-1 pl-6">
                <li>Leads that arrive <strong>from now on</strong> are assigned to a business within seconds.</li>
                <li>You still send each one, and you can take it back or move it as usual.</li>
                <li>Check the businesses&rsquo; priority, caps and hours first: the rules below decide who gets what.</li>
              </ul>
              <label className="flex items-start gap-3">
                <input type="checkbox" name="understand" className="mt-1 size-6" />
                <span className="font-semibold">I understand new leads will be assigned to businesses without me choosing.</span>
              </label>
              <button type="submit" className={primaryButton}>Switch routing on</button>
            </form>
          )
        ) : (
          <p className={`mt-3 ${hintClass}`}>Only an owner can switch routing on or off, or change the rules.</p>
        )}
      </section>

      <section aria-labelledby="stats-heading" className={`${cardClass} mt-6`}>
        <h2 id="stats-heading" className="text-xl font-bold text-ink">The last {stats.windowHours} hours</h2>
        <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ["Leads routed", stats.assigned],
            ["Nobody could take it", stats.noCandidates],
            ["Errors", stats.errors],
            ["Waiting for a person now", stats.unroutableNow],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className={hintClass}>{label}</dt>
              <dd className="text-2xl font-extrabold text-ink">{value}</dd>
            </div>
          ))}
        </dl>
        <p className={`mt-3 ${hintClass}`}>
          Time to decide: typically {ms(stats.p50Ms)}, 95% under {ms(stats.p95Ms)}, slowest {ms(stats.maxMs)}. (The target is under 100 ms for 95% of leads, not counting a wait for another lead being routed at the same moment.)
        </p>
      </section>

      <section aria-labelledby="rules-heading" className="mt-6">
        <h2 id="rules-heading" className="text-xl font-bold text-ink">The rules</h2>
        <p className={`mt-1 max-w-3xl ${hintClass}`}>
          A business must pass <strong>every filter and limit</strong>, then the ranking rules are applied in order to break ties. Always on, whatever you set here: the business is active and covers the postcode, a pause is a pause,
          &ldquo;manual only&rdquo; (weight 0) is never routed, and a business that already had this lead and gave it back does not get it again. Each business&rsquo;s own priority, weight, caps, hours and pauses are on its client page.
        </p>
        <ul className="mt-3 space-y-4">
          {rules.map((rule) => {
            const info = RULE_INFO[rule.type];
            const position = rule.kind === "ranker" ? rankers.findIndex((candidate) => candidate.id === rule.id) : -1;
            return (
              <li key={rule.id} className={cardClass}>
                <div className="flex flex-wrap items-center gap-3">
                  <h3 className="text-lg font-bold text-ink">{info.title}</h3>
                  <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-sm font-semibold text-stone-800">{rule.kind === "filter" ? "Filter" : rule.kind === "limiter" ? "Limit" : `Tie-breaker ${position + 1} of ${rankers.length}`}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-sm font-semibold ${rule.active ? "bg-green-100 text-green-900" : "bg-stone-200 text-stone-800"}`}>{rule.active ? "In use" : "Switched off"}</span>
                </div>
                <p className={`mt-1 ${hintClass}`}>{info.summary}</p>
                {owner ? (
                  <div className="mt-3 flex flex-wrap items-end gap-4">
                    <form action={saveRuleAction} className="flex flex-wrap items-end gap-4">
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <input type="hidden" name="version" value={rule.version} />
                      <label className="flex min-h-12 items-center gap-3 text-lg">
                        <input type="checkbox" name="active" defaultChecked={rule.active} className="size-6" />
                        In use
                      </label>
                      {info.params?.map((param) => (
                        <div key={param.key}>
                          <label htmlFor={`${rule.id}-${param.key}`} className={labelClass}>{param.label}</label>
                          <input
                            id={`${rule.id}-${param.key}`}
                            name={param.key}
                            inputMode="numeric"
                            autoComplete="off"
                            defaultValue={String(rule.config[param.key] ?? "")}
                            aria-describedby={`${rule.id}-${param.key}-hint`}
                            className={`${inputClass} !w-28`}
                          />
                          <p id={`${rule.id}-${param.key}-hint`} className={hintClass}>{param.hint}</p>
                        </div>
                      ))}
                      <button type="submit" className={secondaryButton}>Save</button>
                    </form>
                    {rule.kind === "ranker" && (
                      <div className="flex gap-2">
                        {position > 0 && (
                          <form action={moveRuleAction}>
                            <input type="hidden" name="ruleId" value={rule.id} />
                            <input type="hidden" name="direction" value="up" />
                            <button type="submit" className={secondaryButton} aria-label={`Apply ${info.title} earlier`}>Earlier</button>
                          </form>
                        )}
                        {position < rankers.length - 1 && (
                          <form action={moveRuleAction}>
                            <input type="hidden" name="ruleId" value={rule.id} />
                            <input type="hidden" name="direction" value="down" />
                            <button type="submit" className={secondaryButton} aria-label={`Apply ${info.title} later`}>Later</button>
                          </form>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="mt-2 text-sm">{rule.active ? "In use" : "Switched off"}{info.params?.map((param) => `; ${param.label.toLowerCase()}: ${String(rule.config[param.key] ?? "")}`).join("")}</p>
                )}
              </li>
            );
          })}
        </ul>
        {owner && (
          <form action={saveMaxAgeAction} className={`${cardClass} mt-4 flex flex-wrap items-end gap-4`}>
            <div>
              <label htmlFor="max-age" className={labelClass}>Only route leads younger than (hours)</label>
              <input id="max-age" name="hours" inputMode="numeric" autoComplete="off" defaultValue={String(settings.maxLeadAgeHours)} aria-describedby="max-age-hint" className={`${inputClass} !w-28`} />
              <p id="max-age-hint" className={hintClass}>A lead nobody could take is looked at again until it is this old, then left for you.</p>
            </div>
            <button type="submit" className={secondaryButton}>Save</button>
          </form>
        )}
      </section>

      <section aria-labelledby="runs-heading" className="mt-6">
        <h2 id="runs-heading" className="text-xl font-bold text-ink">Recent decisions</h2>
        {runs.length === 0 ? (
          <p className={`${cardClass} mt-2 text-muted`}>Nothing has been routed yet.</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className="w-full min-w-[44rem] text-left">
              <caption className="sr-only">Recent routing decisions, newest first</caption>
              <thead className="border-b border-stone-200 bg-stone-100 text-sm text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-semibold">When</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Lead</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Result</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Business</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Price</th>
                  <th scope="col" className="px-4 py-3 font-semibold">Took</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-200">
                {runs.map((run) => {
                  const detail = run.candidates as Partial<RunDetail>;
                  return (
                    <tr key={run.id}>
                      <td className="px-4 py-3 text-sm text-muted">{formatShort(run.createdAt)}</td>
                      <td className="px-4 py-3">
                        <Link href={`/admin/leads/${run.leadId}`} className={`${linkClass} font-mono`}>{run.reference}</Link>
                      </td>
                      <td className="px-4 py-3">
                        <RunOutcomeBadge outcome={run.outcome} />
                        {run.error && <span className={`mt-1 block ${hintClass}`}>{runReasonText(run.error)}</span>}
                      </td>
                      <td className="px-4 py-3">{run.chosenClientName ?? (detail.coverage ? `${detail.coverage.covered} covered it` : "–")}</td>
                      <td className="px-4 py-3">{run.pricePence === null ? "–" : formatPence(run.pricePence)}</td>
                      <td className="px-4 py-3 text-sm text-muted">{ms(run.durationMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
