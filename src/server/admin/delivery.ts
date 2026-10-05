import "server-only";
import { randomUUID } from "node:crypto";
import { clientIdSchema } from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for deliveries to businesses (stage 5). Every function authenticates first (requireOperator). */

/** Failed and dead deliveries from the last three days: the queue a person works through. */
export async function loadDeliveryProblems() {
  await requireOperator();
  return getContainer().delivery.problems();
}

export type DeliveryOutcome = { ok: true; leadId: string | undefined } | { ok: false; error: string; leadId: string | undefined };

export async function retryDeliveryFromForm(form: FormData): Promise<DeliveryOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.notificationId);
  const leadId = clientIdSchema.safeParse(fields.leadId);
  const lead = leadId.success ? leadId.data : undefined;
  if (!id.success) return { ok: false, error: "invalid_request", leadId: lead };
  const result = await getContainer().delivery.retry({ operator, notificationId: id.data, requestId: randomUUID() });
  return result.ok ? { ok: true, leadId: lead } : { ok: false, error: result.code, leadId: lead };
}
