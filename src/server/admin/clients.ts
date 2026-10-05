import "server-only";
import { randomUUID } from "node:crypto";
import {
  CLIENT_STATUSES,
  clientIdSchema,
  parseClientInput,
  parseCoverageRule,
  parseDeliverySettings,
  parsePause,
  parseRoutingPreferences,
  parseWorkingHours,
  type ClientFailure,
  type ClientStatus,
  type FieldErrors,
  type FormState as ClientFormState,
} from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for clients and coverage. Every function authenticates first (requireOperator), then validates what a form posted. */

export async function loadClients() {
  await requireOperator();
  return { clients: await getContainer().clients.list() };
}

/** Undefined when the id is malformed or unknown: the page renders a 404 either way. */
export async function loadClient(id: string) {
  await requireOperator();
  const parsed = clientIdSchema.safeParse(id);
  if (!parsed.success) return undefined;
  return getContainer().clients.detail(parsed.data);
}

export type ClientOutcome =
  | { ok: true; clientId: string; notice: string }
  | { ok: false; clientId: string | undefined; error: ClientFailure | "invalid_request" };

export async function createClientFromForm(form: FormData): Promise<{ ok: true; clientId: string } | { ok: false; state: ClientFormState }> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const parsed = parseClientInput(fields);
  if (!parsed.ok) return { ok: false, state: { errors: parsed.errors, values: fields } };
  const { id } = await getContainer().clients.create({ operator, client: parsed.value, requestId: randomUUID() });
  return { ok: true, clientId: id };
}

export async function updateClientFromForm(clientId: string, form: FormData): Promise<{ ok: true } | { ok: false; state: ClientFormState }> {
  const operator = await requireOperator();
  const id = clientIdSchema.safeParse(clientId);
  const fields = formFields(form);
  if (!id.success) return { ok: false, state: { message: "That client no longer exists.", values: fields } };
  const parsed = parseClientInput(fields);
  if (!parsed.ok) return { ok: false, state: { errors: parsed.errors, values: fields } };
  const result = await getContainer().clients.update({ operator, clientId: id.data, client: parsed.value, requestId: randomUUID() });
  return result.ok ? { ok: true } : { ok: false, state: { message: "That client no longer exists.", values: fields } };
}

export async function changeClientStatus(form: FormData): Promise<ClientOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  const status = CLIENT_STATUSES.find((candidate) => candidate === fields.status);
  if (!id.success || !status) return { ok: false, clientId: id.success ? id.data : undefined, error: "invalid_request" };
  const result = await getContainer().clients.setStatus({ operator, clientId: id.data, status: status as ClientStatus, reason: fields.reason, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "status_changed" } : { ok: false, clientId: id.data, error: result.code };
}

export async function changeClientServices(form: FormData): Promise<ClientOutcome> {
  const operator = await requireOperator();
  const id = clientIdSchema.safeParse(form.get("clientId"));
  if (!id.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const slugs = form.getAll("serviceSlug").filter((value): value is string => typeof value === "string");
  const result = await getContainer().clients.setServices({ operator, clientId: id.data, serviceSlugs: slugs, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "services_saved" } : { ok: false, clientId: id.data, error: result.code };
}

export async function addClientCoverage(form: FormData): Promise<ClientOutcome & { fieldErrors?: FieldErrors }> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  if (!id.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const rule = parseCoverageRule(fields);
  if (!rule.ok) return { ok: false, clientId: id.data, error: "invalid_request", fieldErrors: rule.errors };
  const result = await getContainer().clients.addRule({ operator, clientId: id.data, rule: rule.value, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "rule_added" } : { ok: false, clientId: id.data, error: result.code };
}

export async function removeClientCoverage(form: FormData): Promise<ClientOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  const ruleId = clientIdSchema.safeParse(fields.ruleId);
  if (!id.success || !ruleId.success) return { ok: false, clientId: id.success ? id.data : undefined, error: "invalid_request" };
  const result = await getContainer().clients.removeRule({ operator, clientId: id.data, ruleId: ruleId.data, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "rule_removed" } : { ok: false, clientId: id.data, error: result.code };
}

// ------------------------------------------------------------------------------------------------
// Routing preferences: priority, weight, caps, working hours and pauses
// ------------------------------------------------------------------------------------------------

/** What a business asked for about routing, for the client page. */
export async function loadClientRouting(id: string) {
  await requireOperator();
  const parsed = clientIdSchema.safeParse(id);
  if (!parsed.success) return undefined;
  return getContainer().clients.routingPreferences(parsed.data);
}

type PrefsOutcome = ClientOutcome & { fieldErrors?: FieldErrors };

export async function saveClientRoutingPreferences(form: FormData): Promise<PrefsOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  if (!id.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const prefs = parseRoutingPreferences(fields);
  if (!prefs.ok) return { ok: false, clientId: id.data, error: "invalid_request", fieldErrors: prefs.errors };
  const result = await getContainer().clients.setRoutingPreferences({ operator, clientId: id.data, prefs: prefs.value, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "routing_prefs_saved" } : { ok: false, clientId: id.data, error: result.code };
}

export async function saveClientWorkingHours(form: FormData): Promise<PrefsOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  if (!id.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const hours = parseWorkingHours(fields);
  if (!hours.ok) return { ok: false, clientId: id.data, error: "invalid_request", fieldErrors: hours.errors };
  const result = await getContainer().clients.setWorkingHours({ operator, clientId: id.data, windows: hours.value.windows, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "hours_saved" } : { ok: false, clientId: id.data, error: result.code };
}

export async function addClientPause(form: FormData): Promise<PrefsOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  if (!id.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const pause = parsePause(fields);
  if (!pause.ok) return { ok: false, clientId: id.data, error: "invalid_request", fieldErrors: pause.errors };
  const result = await getContainer().clients.addPause({ operator, clientId: id.data, pause: pause.value, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "pause_added" } : { ok: false, clientId: id.data, error: result.code };
}

export async function removeClientPause(form: FormData): Promise<ClientOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  const pauseId = clientIdSchema.safeParse(fields.pauseId);
  if (!id.success || !pauseId.success) return { ok: false, clientId: id.success ? id.data : undefined, error: "invalid_request" };
  const result = await getContainer().clients.removePause({ operator, clientId: id.data, pauseId: pauseId.data, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "pause_removed" } : { ok: false, clientId: id.data, error: result.code };
}

// ------------------------------------------------------------------------------------------------
// Delivery: how the business wants to be told
// ------------------------------------------------------------------------------------------------

export async function loadClientDelivery(id: string) {
  await requireOperator();
  const parsed = clientIdSchema.safeParse(id);
  if (!parsed.success) return undefined;
  const { clients } = getContainer();
  const settings = await clients.deliverySettings(parsed.data);
  return settings && { settings, secretsAvailable: clients.canStoreSecrets() };
}

export async function saveClientDelivery(form: FormData): Promise<PrefsOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.clientId);
  if (!id.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const settings = parseDeliverySettings(fields);
  if (!settings.ok) return { ok: false, clientId: id.data, error: "invalid_request", fieldErrors: settings.errors };
  const result = await getContainer().clients.setDeliverySettings({ operator, clientId: id.data, settings: settings.value, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: id.data, notice: "delivery_saved" } : { ok: false, clientId: id.data, error: result.code };
}

/** The secret is returned to the page ONCE (it is never stored in the clear and nothing can read it back). */
export async function rotateClientWebhookSecret(form: FormData): Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
  const operator = await requireOperator();
  const id = clientIdSchema.safeParse(form.get("clientId"));
  if (!id.success) return { ok: false, error: "invalid_request" };
  const result = await getContainer().clients.rotateWebhookSecret({ operator, clientId: id.data, requestId: randomUUID() });
  return result.ok ? { ok: true, secret: result.secret } : { ok: false, error: result.code };
}

// ------------------------------------------------------------------------------------------------
// The coverage tester
// ------------------------------------------------------------------------------------------------

/** "Which clients would receive a lead here?", using the SAME query routing will use, with the reason for every verdict. */
export async function loadCoverageTester(params: { postcode?: string | undefined; service?: string | undefined; sale?: string | undefined }) {
  await requireOperator();
  return getContainer().coverage.tester(params);
}
