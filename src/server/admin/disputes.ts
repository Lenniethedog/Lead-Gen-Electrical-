import "server-only";
import { randomUUID } from "node:crypto";
import { clientIdSchema } from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for disputes (stage 6, slice 4). Every function authenticates first (requireOperator). */

export async function loadDisputeQueue() {
  await requireOperator();
  return getContainer().disputes.queueFor();
}

/** For the navigation badge: how many are waiting for a decision. */
export async function loadOpenDisputeCount(): Promise<number> {
  await requireOperator();
  return getContainer().disputes.openCount();
}

export type DisputeOutcome = { ok: true; notice: string } | { ok: false; error: string };

export async function decideDisputeFromForm(form: FormData): Promise<DisputeOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const id = clientIdSchema.safeParse(fields.disputeId);
  if (!id.success) return { ok: false, error: "invalid_request" };
  const result = await getContainer().disputes.decide({ operator, disputeId: id.data, fields, requestId: randomUUID() });
  return result.ok ? { ok: true, notice: result.outcome === "upheld" ? "dispute_upheld" : "dispute_rejected" } : { ok: false, error: result.code };
}
