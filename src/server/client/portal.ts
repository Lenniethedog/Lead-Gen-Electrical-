import "server-only";
import type { LeadDetailRow, LeadRow } from "@/modules/portal";
import { getContainer } from "../container";
import { newRequestId, requireClientSession } from "./session";

/**
 * The data-access layer for the business dashboard: the ONLY thing its pages and server actions call. Every function authenticates
 * first (requireClientSession) and hands the verified session to the portal service, which scopes everything to that one business.
 * A business id never arrives from the browser.
 */

export async function loadDashboardHeader(): Promise<{ clientName: string; person: string; canSeeBilling: boolean }> {
  const session = await requireClientSession();
  return { clientName: session.clientName, person: session.name, canSeeBilling: session.role !== "agent" };
}

/** The business's own money. Owners and managers only: an agent works the leads and does not see what they cost. Undefined means "no such page". */
export async function loadBillingForBusiness() {
  const session = await requireClientSession();
  if (session.role === "agent") return undefined;
  return getContainer().billing.forBusiness(session);
}

export async function loadLeadList(view: "open" | "history"): Promise<{ clientName: string; rows: LeadRow[]; more: boolean }> {
  const session = await requireClientSession();
  const { rows, more } = await getContainer().portal.leads(session, view);
  return { clientName: session.clientName, rows, more };
}

/** Undefined when it is not this business's, or does not exist: the page renders a 404 either way. */
export async function loadLeadForClient(assignmentId: string): Promise<LeadDetailRow | undefined> {
  const session = await requireClientSession();
  return getContainer().portal.lead(session, assignmentId, newRequestId());
}

// ---- Answering a lead, and recording what came of it (slice 2). The business and the person come from the session, never the form. ----

export type AnswerOutcome = { ok: true; assignmentId: string; notice: string } | { ok: false; assignmentId: string | undefined; error: string };

const ASSIGNMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string | undefined => (typeof value === "string" && ASSIGNMENT_ID.test(value) ? value : undefined);
const field = (form: FormData, name: string): string | undefined => (typeof form.get(name) === "string" ? (form.get(name) as string) : undefined);

export async function acceptLeadFromForm(form: FormData): Promise<AnswerOutcome> {
  const session = await requireClientSession();
  const assignmentId = idOf(field(form, "assignmentId"));
  if (!assignmentId) return { ok: false, assignmentId: undefined, error: "invalid_request" };
  const result = await getContainer().portal.accept(session, assignmentId, newRequestId());
  return result.ok ? { ok: true, assignmentId, notice: "accepted" } : { ok: false, assignmentId, error: result.code };
}

export async function declineLeadFromForm(form: FormData): Promise<AnswerOutcome> {
  const session = await requireClientSession();
  const assignmentId = idOf(field(form, "assignmentId"));
  if (!assignmentId) return { ok: false, assignmentId: undefined, error: "invalid_request" };
  const result = await getContainer().portal.decline(session, assignmentId, field(form, "reason") ?? "", newRequestId());
  return result.ok ? { ok: true, assignmentId, notice: "declined" } : { ok: false, assignmentId, error: result.code };
}

export async function logContactFromForm(form: FormData): Promise<AnswerOutcome> {
  const session = await requireClientSession();
  const assignmentId = idOf(field(form, "assignmentId"));
  if (!assignmentId) return { ok: false, assignmentId: undefined, error: "invalid_request" };
  const result = await getContainer().portal.logContact(session, assignmentId, { outcome: field(form, "outcome"), note: field(form, "note"), jobValue: field(form, "jobValue") });
  if (result.ok) return { ok: true, assignmentId, notice: "logged" };
  if (result.code === "invalid") return { ok: false, assignmentId, error: result.errors?.outcome ? "invalid_outcome" : result.errors?.jobValue ? "invalid_value" : "invalid_note" };
  return { ok: false, assignmentId, error: result.code };
}

// ---- Reporting a problem with a lead (slice 4) ----

export async function loadDisputesForLead(assignmentId: string) {
  const session = await requireClientSession();
  const id = idOf(assignmentId);
  return id ? getContainer().disputes.forAssignment(session, id) : [];
}

export async function loadDisputeList() {
  const session = await requireClientSession();
  return getContainer().disputes.forBusiness(session);
}

export async function raiseDisputeFromForm(form: FormData): Promise<AnswerOutcome> {
  const session = await requireClientSession();
  const assignmentId = idOf(field(form, "assignmentId"));
  if (!assignmentId) return { ok: false, assignmentId: undefined, error: "invalid_request" };
  const result = await getContainer().disputes.raise(session, assignmentId, { reason: field(form, "reason"), description: field(form, "description") }, newRequestId());
  if (result.ok) return { ok: true, assignmentId, notice: "reported" };
  return { ok: false, assignmentId, error: result.code === "invalid_input" ? (result.errors?.description ? "invalid_description" : "invalid_reason") : result.code };
}

export async function withdrawDisputeFromForm(form: FormData): Promise<AnswerOutcome> {
  const session = await requireClientSession();
  const assignmentId = idOf(field(form, "assignmentId"));
  const disputeId = idOf(field(form, "disputeId"));
  if (!assignmentId || !disputeId) return { ok: false, assignmentId, error: "invalid_request" };
  const result = await getContainer().disputes.withdraw(session, disputeId, newRequestId());
  return result.ok ? { ok: true, assignmentId, notice: "withdrawn" } : { ok: false, assignmentId, error: result.code };
}
