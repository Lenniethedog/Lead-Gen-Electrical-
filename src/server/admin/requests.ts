import "server-only";
import { randomUUID } from "node:crypto";
import { clientIdSchema } from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for requests a business has made to change its coverage or services (stage 6). Every function authenticates first. */

export async function loadClientRequests(clientId: string) {
  await requireOperator();
  const id = clientIdSchema.safeParse(clientId);
  return id.success ? getContainer().portal.openChangeRequests(id.data) : [];
}

/** For the navigation badge on Clients. */
export async function loadOpenRequestCount(): Promise<number> {
  await requireOperator();
  return getContainer().portal.openChangeRequestCount();
}

export type RequestOutcome = { ok: true; clientId: string } | { ok: false; error: string };

export async function markRequestDoneFromForm(form: FormData): Promise<RequestOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.requestId);
  if (!id.success) return { ok: false, error: "invalid_request" };
  const result = await getContainer().portal.markChangeRequestDone({ operator, requestId: id.data, requestRef: randomUUID() });
  return result.ok ? { ok: true, clientId: result.clientId } : { ok: false, error: result.code };
}
