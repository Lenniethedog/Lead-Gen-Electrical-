import "server-only";
import { randomUUID } from "node:crypto";
import { clientIdSchema } from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import type { RoutingFailure } from "@/modules/routing";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/**
 * Data-access layer for automatic routing. Every function authenticates first (requireOperator). Anyone signed in may LOOK at routing and
 * ask "who would get this lead?"; only an owner may change it, and the service re-checks the role (a server action can be POSTed directly).
 */

export async function loadRouting() {
  const operator = await requireOperator();
  return { role: operator.role, ...(await getContainer().routing.overview()) };
}

/** What the lead page shows about routing: every run so far, and, on request, the live "who would get it now?" answer. */
export async function loadLeadRouting(leadId: string, options: { explain: boolean }) {
  await requireOperator();
  const { routing } = getContainer();
  const [runs, explanation] = await Promise.all([routing.runsForLead(leadId), options.explain ? routing.explain(leadId) : Promise.resolve(undefined)]);
  return { runs, explanation };
}

export type RoutingOutcome = { ok: true; notice: string } | { ok: false; error: RoutingFailure | "invalid_request"; detail?: string | undefined };

const checkbox = (value: string | undefined) => value === "on" || value === "true";
const failure = (result: { ok: false; code: RoutingFailure; message?: string | undefined }): RoutingOutcome => ({ ok: false, error: result.code, detail: result.message });

export async function setRoutingEnabledFromForm(form: FormData): Promise<RoutingOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const enabled = fields.enabled === "true";
  // Switching ON hands real leads to real businesses with nobody in the loop: it takes a deliberate tick, not just a click.
  if (enabled && !checkbox(fields.understand)) return { ok: false, error: "invalid_request", detail: "Tick the box to confirm you understand what switching routing on does." };
  const result = await getContainer().routing.setEnabled({ operator, enabled, requestId: randomUUID() });
  return result.ok ? { ok: true, notice: enabled ? "routing_on" : "routing_off" } : failure(result);
}

export async function saveMaxAgeFromForm(form: FormData): Promise<RoutingOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const hours = /^\d{1,3}$/.test(fields.hours ?? "") ? Number(fields.hours) : Number.NaN;
  const result = await getContainer().routing.setMaxLeadAge({ operator, hours, requestId: randomUUID() });
  return result.ok ? { ok: true, notice: "routing_age_saved" } : failure(result);
}

/** The settings a rule can have, as posted. Anything that is not a clean whole number is passed on as text so the rule's own schema rejects it. */
const asNumber = (raw: string): number | string => (/^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : raw);

export async function saveRuleFromForm(form: FormData): Promise<RoutingOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const ruleId = clientIdSchema.safeParse(fields.ruleId);
  const version = /^\d{1,9}$/.test(fields.version ?? "") ? Number(fields.version) : Number.NaN;
  if (!ruleId.success || Number.isNaN(version)) return { ok: false, error: "invalid_request" };
  const config: Record<string, unknown> = {};
  if (fields.graceMinutes !== undefined) config.graceMinutes = asNumber(fields.graceMinutes);
  if (fields.windowDays !== undefined) config.windowDays = asNumber(fields.windowDays);
  const result = await getContainer().routing.updateRule({ operator, ruleId: ruleId.data, expectedVersion: version, active: checkbox(fields.active), config, requestId: randomUUID() });
  return result.ok ? { ok: true, notice: "routing_rule_saved" } : failure(result);
}

export async function moveRuleFromForm(form: FormData): Promise<RoutingOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const ruleId = clientIdSchema.safeParse(fields.ruleId);
  const direction = fields.direction === "up" || fields.direction === "down" ? fields.direction : undefined;
  if (!ruleId.success || !direction) return { ok: false, error: "invalid_request" };
  const result = await getContainer().routing.moveRule({ operator, ruleId: ruleId.data, direction, requestId: randomUUID() });
  return result.ok ? { ok: true, notice: "routing_rule_moved" } : failure(result);
}
