import type { Logger } from "pino";
import { DASHBOARD_PAGE_SIZE } from "@/config/client-dashboard";
import { withClientScope } from "@/lib/db/client-scope";
import type { Database } from "@/lib/db/client";
import { writeAudit } from "@/modules/audit";
import type { ClientSession } from "@/modules/clientauth";
import type { AssignmentResult, AssignmentService } from "@/modules/assignments";
import { getLeadDetail, insertContactAttempt, listContactAttempts, listLeads, lockOwnAssignmentStatus, type LeadDetailRow, type LeadRow } from "./repo";
import { parseContactAttempt, type ContactAttemptInput } from "./schemas";

export interface PortalServiceDeps {
  db: Database;
  logger: Logger;
  assignments: AssignmentService;
}

/**
 * What a business's signed-in people can see and do. EVERY function takes the verified `ClientSession` and works only inside
 * `withClientScope(session.clientId)`: the business is never a parameter a caller can choose (docs/00 D45).
 */
export function createPortalService(deps: PortalServiceDeps) {
  const { db, assignments } = deps;

  return {
    leads(session: ClientSession, view: "open" | "history"): Promise<{ rows: LeadRow[]; more: boolean }> {
      return withClientScope(db, session.clientId, (scoped) => listLeads(scoped, session.clientId, { view, limit: DASHBOARD_PAGE_SIZE }));
    },

    /**
     * One lead. When it shows the person's contact details, that is written to the audit trail (D46): who in which business saw
     * which lead, never the details themselves. A lead that is not this business's is simply not found, as if it did not exist.
     */
    async lead(session: ClientSession, assignmentId: string, requestId: string): Promise<LeadDetailRow | undefined> {
      if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) return undefined;
      return withClientScope(db, session.clientId, async (scoped) => {
        const base = await getLeadDetail(scoped, session.clientId, assignmentId);
        const detail = base && { ...base, attempts: await listContactAttempts(scoped, session.clientId, assignmentId) };
        if (detail?.contactState === "visible") {
          await writeAudit(scoped, {
            actorType: "client_user",
            actorId: session.userId,
            action: "lead.contact_viewed",
            entityType: "assignment",
            entityId: detail.assignmentId,
            after: { client_id: session.clientId, reference: detail.reference },
            requestId,
          });
        }
        return detail;
      });
    },
    /** Accept a lead the business holds. */
    accept(session: ClientSession, assignmentId: string, requestId: string): Promise<AssignmentResult<{ alreadyAccepted: boolean }>> {
      return assignments.acceptByBusiness({ clientId: session.clientId, clientUserId: session.userId, assignmentId, requestId });
    },

    /** Decline a lead it has not accepted, for a reason from the closed list. The lead goes to a different business. */
    decline(session: ClientSession, assignmentId: string, reason: string, requestId: string): Promise<AssignmentResult> {
      return assignments.declineByBusiness({ clientId: session.clientId, clientUserId: session.userId, assignmentId, reason, requestId });
    },

    /**
     * Records what happened when the business got in touch. Only for a lead it has ACCEPTED (or is disputing): logging a call on a lead you
     * have not taken, or one that is gone, would be a record of something that was not yours. The assignment row is locked so the check and
     * the insert agree.
     */
    async logContact(session: ClientSession, assignmentId: string, fields: Record<string, string | undefined>): Promise<
      { ok: true } | { ok: false; code: "not_found" | "not_accepted" | "invalid"; errors?: Record<string, string> }
    > {
      if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) return { ok: false, code: "not_found" };
      const parsed = parseContactAttempt(fields);
      if (!parsed.ok) return { ok: false, code: "invalid", errors: parsed.errors as Record<string, string> };
      const input: ContactAttemptInput = parsed.value;
      return withClientScope(db, session.clientId, async (scoped) => {
        const status = await lockOwnAssignmentStatus(scoped, session.clientId, assignmentId);
        if (!status) return { ok: false, code: "not_found" } as const;
        if (status !== "accepted" && status !== "disputed") return { ok: false, code: "not_accepted" } as const;
        await insertContactAttempt(scoped, { assignmentId, outcome: input.outcome, note: input.note, jobValuePence: input.jobValuePence, createdBy: session.userId });
        return { ok: true } as const;
      });
    },
  };
}

export type PortalService = ReturnType<typeof createPortalService>;
