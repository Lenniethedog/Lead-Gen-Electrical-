import type { Logger } from "pino";
import { DASHBOARD_PAGE_SIZE } from "@/config/client-dashboard";
import { withClientScope } from "@/lib/db/client-scope";
import type { Database } from "@/lib/db/client";
import { writeAudit } from "@/modules/audit";
import type { ClientSession } from "@/modules/clientauth";
import type { AssignmentResult, AssignmentService } from "@/modules/assignments";
import type { Operator } from "@/modules/inbox";
import {
  countOpenChangeRequests, countOpenChangeRequestsFor, getLeadDetail, getNotificationState, getPerformance, getServiceAreaView, insertChangeRequest, insertContactAttempt, listChangeRequests,
  listContactAttempts, listLeads, listOpenChangeRequests, lockOwnAssignmentStatus, markChangeRequestDone, updateNotificationState,
  type ChangeRequestRow, type LeadDetailRow, type LeadRow, type NotificationState, type PerformanceRow, type ServiceAreaView,
} from "./repo";
import { parseChangeRequest, parseContactAttempt, parseNotificationSettings, type ContactAttemptInput } from "./schemas";

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
    // ---- How the business is told (slice 5) ----

    notificationSettings(session: ClientSession): Promise<NotificationState | undefined> {
      return withClientScope(db, session.clientId, (scoped) => getNotificationState(scoped, session.clientId));
    },

    /**
     * The business changes how it is told. An agent cannot. A manager can switch email and text on or off; only an OWNER can change WHERE leads
     * (which carry people's details) are sent, so one person's stolen sign-in cannot quietly redirect them. At least one way must stay on for a
     * business on automatic delivery, a text needs a number, and every change is audited with the person who made it. The webhook is staff's.
     */
    async saveNotificationSettings(session: ClientSession, fields: Record<string, string | undefined>, requestId: string): Promise<
      { ok: true } | { ok: false; code: "forbidden" | "not_found" | "invalid" | "no_channel" | "unchanged"; errors?: Record<string, string> }
    > {
      if (session.role === "agent") return { ok: false, code: "forbidden" };
      const parsed = parseNotificationSettings(fields);
      if (!parsed.ok) return { ok: false, code: "invalid", errors: parsed.errors as Record<string, string> };
      const next = parsed.value;
      return withClientScope(db, session.clientId, async (scoped) => {
        const before = await getNotificationState(scoped, session.clientId);
        if (!before) return { ok: false, code: "not_found" } as const;
        const addressChanged = next.contactEmail !== before.contactEmail || next.contactPhone !== before.contactPhone;
        if (addressChanged && session.role !== "owner") return { ok: false, code: "forbidden" } as const;
        if (before.mode === "automatic" && !next.email && !next.sms && !before.webhook) return { ok: false, code: "no_channel" } as const;
        if (next.email === before.email && next.sms === before.sms && !addressChanged) return { ok: false, code: "unchanged" } as const;
        await updateNotificationState(scoped, session.clientId, next);
        await writeAudit(scoped, {
          actorType: "client_user", actorId: session.userId, action: "client.notification_settings_changed", entityType: "client", entityId: session.clientId,
          before: { notify_email: before.email, notify_sms: before.sms, contact_email: before.contactEmail, contact_phone_set: before.contactPhone !== null },
          after: { notify_email: next.email, notify_sms: next.sms, contact_email: next.contactEmail, contact_phone_set: next.contactPhone !== null, address_changed: addressChanged },
          requestId,
        });
        return { ok: true } as const;
      });
    },

    // ---- Where and what it covers: read-only, with a way to ask (slice 5) ----

    serviceAreas(session: ClientSession): Promise<ServiceAreaView> {
      return withClientScope(db, session.clientId, (scoped) => getServiceAreaView(scoped, session.clientId));
    },

    myChangeRequests(session: ClientSession): Promise<ChangeRequestRow[]> {
      return withClientScope(db, session.clientId, (scoped) => listChangeRequests(scoped, session.clientId, 20));
    },

    /** A business asks staff to change its coverage or services. At most five open at once, so a stuck page cannot flood the queue. */
    async requestChange(session: ClientSession, fields: Record<string, string | undefined>, requestId: string): Promise<{ ok: true } | { ok: false; code: "forbidden" | "invalid" | "too_many"; errors?: Record<string, string> }> {
      if (session.role === "agent") return { ok: false, code: "forbidden" };
      const parsed = parseChangeRequest(fields);
      if (!parsed.ok) return { ok: false, code: "invalid", errors: parsed.errors as Record<string, string> };
      return withClientScope(db, session.clientId, async (scoped) => {
        // Serialise this business's requests so two at once cannot both pass the limit.
        await scoped.selectFrom("clients").select("id").where("id", "=", session.clientId).forUpdate().executeTakeFirst();
        if ((await countOpenChangeRequestsFor(scoped, session.clientId)) >= 5) return { ok: false, code: "too_many" } as const;
        const id = await insertChangeRequest(scoped, { clientId: session.clientId, kind: parsed.value.kind, message: parsed.value.message, requestedBy: session.userId });
        await writeAudit(scoped, { actorType: "client_user", actorId: session.userId, action: "client.change_requested", entityType: "client", entityId: session.clientId, after: { request_id: id, kind: parsed.value.kind }, requestId });
        return { ok: true } as const;
      });
    },

    /** Staff: what businesses have asked for, and marking one done (after making the change on the client page). */
    openChangeRequests: (clientId?: string) => listOpenChangeRequests(db, clientId),
    openChangeRequestCount: () => countOpenChangeRequests(db),
    async markChangeRequestDone(input: { operator: Operator; requestId: string; requestRef: string }): Promise<{ ok: true; clientId: string } | { ok: false; code: "not_found" }> {
      if (!/^[0-9a-f-]{36}$/i.test(input.requestId)) return { ok: false, code: "not_found" };
      return db.transaction().execute(async (trx) => {
        const done = await markChangeRequestDone(trx, input.requestId, input.operator.id);
        if (!done) return { ok: false, code: "not_found" } as const;
        await writeAudit(trx, { actorId: input.operator.id, action: "client.change_request_done", entityType: "client", entityId: done.clientId, after: { request_id: input.requestId }, requestId: input.requestRef });
        return { ok: true, clientId: done.clientId } as const;
      });
    },

    // ---- Counts (slice 5) ----

    /** Money-related figures are withheld for an agent here, not just hidden by the page. */
    async performance(session: ClientSession, days: number): Promise<PerformanceRow & { moneyHidden: boolean }> {
      const window = [7, 30, 90].includes(days) ? days : 30;
      const row = await withClientScope(db, session.clientId, (scoped) => getPerformance(scoped, session.clientId, window));
      const moneyHidden = session.role === "agent";
      return moneyHidden ? { ...row, wonValuePence: 0, spendPence: 0, moneyHidden } : { ...row, moneyHidden };
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
