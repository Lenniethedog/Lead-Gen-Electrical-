import type { Logger } from "pino";
import { DASHBOARD_PAGE_SIZE } from "@/config/client-dashboard";
import { withClientScope } from "@/lib/db/client-scope";
import type { Database } from "@/lib/db/client";
import { writeAudit } from "@/modules/audit";
import type { ClientSession } from "@/modules/clientauth";
import { getLeadDetail, listLeads, type LeadDetailRow, type LeadRow } from "./repo";

export interface PortalServiceDeps {
  db: Database;
  logger: Logger;
}

/**
 * What a business's signed-in people can see and do. EVERY function takes the verified `ClientSession` and works only inside
 * `withClientScope(session.clientId)`: the business is never a parameter a caller can choose (docs/00 D45).
 */
export function createPortalService(deps: PortalServiceDeps) {
  const { db } = deps;

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
        const detail = await getLeadDetail(scoped, session.clientId, assignmentId);
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
  };
}

export type PortalService = ReturnType<typeof createPortalService>;
