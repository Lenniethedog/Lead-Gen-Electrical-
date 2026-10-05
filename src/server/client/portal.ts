import "server-only";
import type { LeadDetailRow, LeadRow } from "@/modules/portal";
import { getContainer } from "../container";
import { newRequestId, requireClientSession } from "./session";

/**
 * The data-access layer for the business dashboard: the ONLY thing its pages and server actions call. Every function authenticates
 * first (requireClientSession) and hands the verified session to the portal service, which scopes everything to that one business.
 * A business id never arrives from the browser.
 */

export async function loadDashboardHeader(): Promise<{ clientName: string; person: string }> {
  const session = await requireClientSession();
  return { clientName: session.clientName, person: session.name };
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
