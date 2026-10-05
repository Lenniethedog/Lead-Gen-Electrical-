import "server-only";
import { randomUUID } from "node:crypto";
import { CLIENT_USER_ROLES, type ClientUserRole } from "@/config/client-auth";
import { clientIdSchema } from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for the people who may sign in to a business's dashboard (stage 6). Every function authenticates first (requireOperator). */

export async function loadClientUsers(clientId: string) {
  await requireOperator();
  const id = clientIdSchema.safeParse(clientId);
  if (!id.success) return [];
  return getContainer().clientAuth.users(id.data);
}

export type UserOutcome = { ok: true; clientId: string; notice: string } | { ok: false; clientId: string | undefined; error: string };

const userId = (value: unknown) => clientIdSchema.safeParse(value);
const role = (value: unknown): ClientUserRole | undefined => CLIENT_USER_ROLES.find((candidate) => candidate === value);

export async function inviteClientUser(form: FormData): Promise<UserOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const client = clientIdSchema.safeParse(fields.clientId);
  const chosen = role(fields.role);
  if (!client.success || !chosen) return { ok: false, clientId: client.success ? client.data : undefined, error: "invalid_request" };
  const result = await getContainer().clientAuth.invite({ operator, clientId: client.data, email: fields.email ?? "", name: fields.name ?? "", role: chosen, requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: client.data, notice: "user_invited" } : { ok: false, clientId: client.data, error: result.code };
}

/** One lookup for the three actions that act on an existing person: which business they belong to (for the redirect back). */
async function ownerOf(personId: string): Promise<string | undefined> {
  const user = (await getContainer().clientAuth.find(personId))?.clientId;
  return user;
}

export async function resendClientUserLink(form: FormData): Promise<UserOutcome> {
  const operator = await requireOperator();
  const person = userId(formFields(form).userId);
  if (!person.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const clientId = await ownerOf(person.data);
  const result = await getContainer().clientAuth.resend({ operator, userId: person.data, requestId: randomUUID() });
  return result.ok && clientId ? { ok: true, clientId, notice: "user_link_sent" } : { ok: false, clientId, error: result.ok ? "not_found" : result.code };
}

export async function setClientUserDisabled(form: FormData): Promise<UserOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const person = userId(fields.userId);
  if (!person.success || (fields.disabled !== "true" && fields.disabled !== "false")) return { ok: false, clientId: undefined, error: "invalid_request" };
  const disabled = fields.disabled === "true";
  const clientId = await ownerOf(person.data);
  const result = await getContainer().clientAuth.setStatus({ operator, userId: person.data, disabled, requestId: randomUUID() });
  return result.ok && clientId ? { ok: true, clientId, notice: disabled ? "user_disabled" : "user_enabled" } : { ok: false, clientId, error: result.ok ? "not_found" : result.code };
}

export async function setClientUserRole(form: FormData): Promise<UserOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const person = userId(fields.userId);
  const chosen = role(fields.role);
  if (!person.success || !chosen) return { ok: false, clientId: undefined, error: "invalid_request" };
  const clientId = await ownerOf(person.data);
  const result = await getContainer().clientAuth.setRole({ operator, userId: person.data, role: chosen, requestId: randomUUID() });
  return result.ok && clientId ? { ok: true, clientId, notice: "user_role_changed" } : { ok: false, clientId, error: result.ok ? "not_found" : result.code };
}
