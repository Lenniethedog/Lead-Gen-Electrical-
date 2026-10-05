import "server-only";
import { randomUUID } from "node:crypto";
import {
  decisionSchema,
  formFields,
  handledSchema,
  leadIdSchema,
} from "@/modules/inbox/schemas";
import { INBOX_VIEWS, type ActionFailure, type InboxView, type LeadDetail, type InboxRow } from "@/modules/inbox";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/**
 * The data-access layer for the operator inbox: the ONLY thing the admin pages and server actions
 * call. Every function authenticates first (requireOperator), validates its input, and returns
 * plain data for the UI. Pages never touch the database, repositories or services directly
 * (enforced by lint).
 */

export function parseView(value: string | string[] | undefined): InboxView {
  const first = Array.isArray(value) ? value[0] : value;
  return INBOX_VIEWS.find((view) => view === first) ?? "open";
}

export async function loadInbox(view: InboxView): Promise<{ operatorEmail: string; view: InboxView; rows: InboxRow[]; total: number; openCount: number }> {
  const operator = await requireOperator();
  const { rows, total, openCount } = await getContainer().inbox.list(view);
  return { operatorEmail: operator.email, view, rows, total, openCount };
}

/** Undefined when the id is malformed or no such lead exists: the page renders a 404 either way. */
export async function loadLeadDetail(id: string): Promise<{ operatorEmail: string; lead: LeadDetail } | undefined> {
  const operator = await requireOperator();
  const parsed = leadIdSchema.safeParse(id);
  if (!parsed.success) return undefined;
  const lead = await getContainer().inbox.detail(parsed.data);
  return lead ? { operatorEmail: operator.email, lead } : undefined;
}

export async function loadOperatorEmail(): Promise<string> {
  return (await requireOperator()).email;
}

export type ActionOutcome =
  | { ok: true; leadId: string; notice: "approved" | "rejected" | "handled" }
  | { ok: false; leadId: string | undefined; error: ActionFailure | "invalid_request" };

/** Approve or reject a held lead. `form` is the untrusted FormData the browser posted. */
export async function decideHeldLead(form: FormData): Promise<ActionOutcome> {
  const operator = await requireOperator();
  const fields = decisionSchema.safeParse(formFields(form));
  if (!fields.success) return { ok: false, leadId: leadIdOf(form), error: "invalid_request" };

  const { leadId, decision, reason } = fields.data;
  const inbox = getContainer().inbox;
  const requestId = randomUUID();
  const result =
    decision === "approve"
      ? await inbox.approve({ operator, leadId, reason, requestId })
      : await inbox.reject({ operator, leadId, reason, requestId });
  return result.ok ? { ok: true, leadId, notice: decision === "approve" ? "approved" : "rejected" } : { ok: false, leadId, error: result.code };
}

export async function markLeadHandled(form: FormData): Promise<ActionOutcome> {
  const operator = await requireOperator();
  const fields = handledSchema.safeParse(formFields(form));
  if (!fields.success) return { ok: false, leadId: leadIdOf(form), error: "invalid_request" };

  const result = await getContainer().inbox.markHandled({ operator, leadId: fields.data.leadId, requestId: randomUUID() });
  return result.ok ? { ok: true, leadId: fields.data.leadId, notice: "handled" } : { ok: false, leadId: fields.data.leadId, error: result.code };
}

function leadIdOf(form: FormData): string | undefined {
  const value = form.get("leadId");
  const parsed = leadIdSchema.safeParse(typeof value === "string" ? value : "");
  return parsed.success ? parsed.data : undefined;
}
