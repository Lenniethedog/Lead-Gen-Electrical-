import "server-only";
import { randomUUID } from "node:crypto";
import { clientIdSchema } from "@/modules/clients";
import type { AssignmentFailure, Candidates, LeadAssignmentView } from "@/modules/assignments";
import { formFields } from "@/modules/inbox/schemas";
import { parsePoundsToPence } from "@/modules/pricing";
import type { NotificationView } from "@/modules/delivery";
import type { PrivacyFailure } from "@/modules/privacy";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for handing leads to businesses, and for the privacy actions on a lead. */

export interface LeadWork {
  role: "owner" | "staff";
  candidates: Candidates | undefined;
  assignments: LeadAssignmentView[];
  /** The text to send to each business currently holding the lead (contains the consumer's details: shown only to a signed-in operator). */
  handovers: Record<string, { subject: string; text: string; to: string }>;
  /** What automatic delivery did for each assignment (empty for a business on manual delivery). */
  deliveries: NotificationView[];
  /** Businesses that were SENT this lead's details: if the consumer withdrew consent or was erased, tell them to stop and delete. */
  sentTo: Array<{ clientName: string; contactName: string | null; contactEmail: string; contactPhone: string | null }>;
}

export async function loadLeadWork(leadId: string): Promise<LeadWork> {
  const operator = await requireOperator();
  const { assignments: service } = getContainer();
  const [candidates, assignments, deliveries] = await Promise.all([service.candidates(leadId), service.forLead(leadId), getContainer().delivery.forLead(leadId)]);
  const handovers: LeadWork["handovers"] = {};
  for (const assignment of assignments.filter((entry) => entry.active)) {
    const message = await service.handover(assignment.id);
    if (message) handovers[assignment.id] = message;
  }
  const sentTo = assignments
    .filter((assignment) => assignment.history.some((entry) => entry.to === "notified" || entry.to === "accepted"))
    .map((assignment) => ({ clientName: assignment.clientName, contactName: assignment.clientContactName, contactEmail: assignment.clientContactEmail, contactPhone: assignment.clientContactPhone }));
  return { role: operator.role, candidates, assignments, deliveries, handovers, sentTo };
}

export type WorkOutcome =
  | { ok: true; leadId: string; notice: string }
  | { ok: false; leadId: string | undefined; error: AssignmentFailure | PrivacyFailure | "invalid_request"; reasons?: string[] | undefined };

const checkbox = (value: string | undefined) => value === "on" || value === "true";

/** "35", "35.50" -> pence; blank -> undefined (use the pricing rule); anything else is invalid. */
function optionalPrice(value: string | undefined): { ok: true; pence: number | undefined } | { ok: false } {
  if (value === undefined || value.trim() === "") return { ok: true, pence: undefined };
  const pence = parsePoundsToPence(value);
  return pence === undefined ? { ok: false } : { ok: true, pence };
}

export async function assignLeadFromForm(form: FormData): Promise<WorkOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const leadId = clientIdSchema.safeParse(fields.leadId);
  const clientId = clientIdSchema.safeParse(fields.clientId);
  const price = optionalPrice(fields.price);
  if (!leadId.success || !clientId.success || !price.ok) return { ok: false, leadId: leadId.success ? leadId.data : undefined, error: "invalid_request" };
  const result = await getContainer().assignments.assign({
    operator,
    leadId: leadId.data,
    clientId: clientId.data,
    coverageException: checkbox(fields.coverageException),
    ...(price.pence !== undefined && { manualPricePence: price.pence }),
    requestId: randomUUID(),
  });
  return result.ok ? { ok: true, leadId: leadId.data, notice: "assigned" } : { ok: false, leadId: leadId.data, error: result.code, reasons: result.reasons };
}

export async function markSentFromForm(form: FormData): Promise<WorkOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const leadId = clientIdSchema.safeParse(fields.leadId);
  const assignmentId = clientIdSchema.safeParse(fields.assignmentId);
  if (!leadId.success || !assignmentId.success) return { ok: false, leadId: leadId.success ? leadId.data : undefined, error: "invalid_request" };
  const result = await getContainer().assignments.markSent({ operator, assignmentId: assignmentId.data, requestId: randomUUID() });
  return result.ok ? { ok: true, leadId: leadId.data, notice: "sent" } : { ok: false, leadId: leadId.data, error: result.code };
}

export async function cancelAssignmentFromForm(form: FormData): Promise<WorkOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const leadId = clientIdSchema.safeParse(fields.leadId);
  const assignmentId = clientIdSchema.safeParse(fields.assignmentId);
  if (!leadId.success || !assignmentId.success) return { ok: false, leadId: leadId.success ? leadId.data : undefined, error: "invalid_request" };
  const result = await getContainer().assignments.cancel({ operator, assignmentId: assignmentId.data, reason: fields.reason ?? "", requestId: randomUUID() });
  return result.ok ? { ok: true, leadId: leadId.data, notice: "cancelled" } : { ok: false, leadId: leadId.data, error: result.code };
}

export async function reassignFromForm(form: FormData): Promise<WorkOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const leadId = clientIdSchema.safeParse(fields.leadId);
  const assignmentId = clientIdSchema.safeParse(fields.assignmentId);
  const toClientId = clientIdSchema.safeParse(fields.toClientId);
  const price = optionalPrice(fields.price);
  if (!leadId.success || !assignmentId.success || !toClientId.success || !price.ok) return { ok: false, leadId: leadId.success ? leadId.data : undefined, error: "invalid_request" };
  const result = await getContainer().assignments.reassign({
    operator,
    assignmentId: assignmentId.data,
    toClientId: toClientId.data,
    reason: fields.reason ?? "",
    coverageException: checkbox(fields.coverageException),
    ...(price.pence !== undefined && { manualPricePence: price.pence }),
    requestId: randomUUID(),
  });
  return result.ok ? { ok: true, leadId: leadId.data, notice: "reassigned" } : { ok: false, leadId: leadId.data, error: result.code, reasons: result.reasons };
}

// ------------------------------------------------------------------------------------------------
// Privacy
// ------------------------------------------------------------------------------------------------

/** Withdrawing consent is open to every operator: it must be quick and easy to honour. */
export async function withdrawConsentFromForm(form: FormData): Promise<WorkOutcome> {
  const operator = await requireOperator();
  const leadId = clientIdSchema.safeParse(form.get("leadId"));
  if (!leadId.success) return { ok: false, leadId: undefined, error: "invalid_request" };
  const result = await getContainer().privacy.withdrawConsent({ operator, leadId: leadId.data, requestId: randomUUID() });
  return result.ok ? { ok: true, leadId: leadId.data, notice: result.alreadyDone ? "already_withdrawn" : "withdrawn" } : { ok: false, leadId: leadId.data, error: result.code };
}

/** Erasing is for owners only: the service refuses anyone else even if this check were bypassed. */
export async function eraseLeadFromForm(form: FormData): Promise<WorkOutcome> {
  const operator = await requireOperator();
  const fields = formFields(form);
  const leadId = clientIdSchema.safeParse(fields.leadId);
  if (!leadId.success) return { ok: false, leadId: undefined, error: "invalid_request" };
  const result = await getContainer().privacy.erase({ operator, leadId: leadId.data, reason: fields.reason ?? "", requestId: randomUUID() });
  return result.ok ? { ok: true, leadId: leadId.data, notice: result.alreadyDone ? "already_erased" : "erased" } : { ok: false, leadId: leadId.data, error: result.code };
}
