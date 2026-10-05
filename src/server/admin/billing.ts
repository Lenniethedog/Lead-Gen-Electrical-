import "server-only";
import { randomUUID } from "node:crypto";
import { CREDIT_KIND_CODES } from "@/config/billing";
import { clientIdSchema } from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for a business's credit and charges (stage 6). Every function authenticates first (requireOperator). */

export async function loadClientBilling(clientId: string) {
  await requireOperator();
  const id = clientIdSchema.safeParse(clientId);
  if (!id.success) return undefined;
  return getContainer().billing.forStaff(id.data);
}

/** Money problems across every business: empty means wallets, ledgers and charges all agree. */
export async function loadMoneyProblems() {
  await requireOperator();
  return getContainer().billing.problems();
}

export type BillingOutcome = { ok: true; clientId: string; notice: string } | { ok: false; clientId: string | undefined; error: string };

/** The form posts `entry` as "kind:reason" (one select), the amount, and the id of the form that was rendered (so pressing twice posts once). */
export async function postClientCredit(form: FormData): Promise<BillingOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const client = clientIdSchema.safeParse(fields.clientId);
  if (!client.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const [kind, reason] = (fields.entry ?? "").split(":");
  if (!kind || !reason || !(CREDIT_KIND_CODES as readonly string[]).includes(kind)) return { ok: false, clientId: client.data, error: "invalid_input" };
  const result = await getContainer().billing.post({ operator, clientId: client.data, postingId: fields.postingId ?? "", fields: { kind, reason, amount: fields.amount }, requestId: randomUUID() });
  if (!result.ok) return { ok: false, clientId: client.data, error: result.code };
  return { ok: true, clientId: client.data, notice: result.replay ? "credit_replay" : "credit_posted" };
}

export async function changeBillingMode(form: FormData): Promise<BillingOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const client = clientIdSchema.safeParse(fields.clientId);
  if (!client.success) return { ok: false, clientId: undefined, error: "invalid_request" };
  const result = await getContainer().billing.setMode({ operator, clientId: client.data, mode: fields.billingMode ?? "", requestId: randomUUID() });
  return result.ok ? { ok: true, clientId: client.data, notice: "billing_mode_changed" } : { ok: false, clientId: client.data, error: result.code };
}
