import type { Logger } from "pino";
import { DISPUTE_DECISION_REASONS } from "@/config/disputes";
import { setClientContext, setStaffContext } from "@/lib/db/audit-context";
import type { Database } from "@/lib/db/client";
import { withClientScope } from "@/lib/db/client-scope";
import { LEAD_EVENT } from "@/config/lead-events";
import { insertLeadEvent, activeAssignmentsForLead, lockAssignment, lockLead, transitionAssignment, transitionLead } from "@/modules/assignments";
import { writeAudit } from "@/modules/audit";
import type { ClientSession } from "@/modules/clientauth";
import type { Operator } from "@/modules/inbox";
import { countOpen, detail, inWindow, insertDispute, listForAssignment, listForBusiness, lockDispute, markDecided, markWithdrawn, peekAssignment, peekDispute, queue, type DisputeRow } from "./repo";
import { parseDecision, parseDispute } from "./schemas";

export interface DisputeServiceDeps {
  db: Database;
  logger: Logger;
}

export type DisputeFailure =
  | "not_found" | "not_disputable" | "window_closed" | "already_disputed" | "invalid_input"
  | "not_open" | "invalid_outcome" | "invalid_resolution" | "invalid_decision_reason" | "inconsistent";
export type DisputeResult<T = object> = ({ ok: true } & T) | { ok: false; code: DisputeFailure; errors?: Record<string, string> };

/**
 * Problems with leads, and what staff do about them. The lead is locked first, then the assignment, then the dispute (the same order as
 * everywhere else); the money follows from the assignment's new status by the database's own trigger, so a refund can never be forgotten
 * or made twice here (docs/00 D50, D55-D58).
 */
export function createDisputeService(deps: DisputeServiceDeps) {
  const { db } = deps;

  return {
    // ---- the business ----

    /**
     * Reports a problem with a lead the business holds (not yet decided otherwise), within the window. The assignment becomes `disputed`; the
     * charge stays until staff decide. One dispute per lead: a decided one is final, a withdrawn one may be raised again.
     */
    async raise(session: ClientSession, assignmentId: string, fields: Record<string, string | undefined>, requestId: string): Promise<DisputeResult<{ disputeId: string }>> {
      if (!/^[0-9a-f-]{36}$/i.test(assignmentId)) return { ok: false, code: "not_found" };
      const parsed = parseDispute(fields);
      if (!parsed.ok) return { ok: false, code: "invalid_input", errors: parsed.errors as Record<string, string> };
      const peek = await peekAssignment(db, assignmentId);
      if (!peek || peek.clientId !== session.clientId) return { ok: false, code: "not_found" };
      try {
        return await db.transaction().execute(async (trx): Promise<DisputeResult<{ disputeId: string }>> => {
          const lead = await lockLead(trx, peek.leadId);
          const assignment = await lockAssignment(trx, assignmentId);
          if (!lead || !assignment || assignment.clientId !== session.clientId) return { ok: false, code: "not_found" };
          if (assignment.status !== "reserved" && assignment.status !== "notified" && assignment.status !== "accepted") return { ok: false, code: "not_disputable" };
          if (!(await inWindow(trx, assignment.id))) return { ok: false, code: "window_closed" };
          await setClientContext(trx, { clientUserId: session.userId, reason: "dispute_raised", requestId });
          let from = assignment.status;
          if (from === "reserved") {
            if (!(await transitionAssignment(trx, assignment.id, "reserved", "notified"))) return { ok: false, code: "not_disputable" };
            from = "notified";
          }
          if (!(await transitionAssignment(trx, assignment.id, from, "disputed"))) return { ok: false, code: "not_disputable" };
          const disputeId = await insertDispute(trx, { assignmentId: assignment.id, clientId: session.clientId, reason: parsed.value.reason, description: parsed.value.description, raisedBy: session.userId });
          await insertLeadEvent(trx, { leadId: lead.id, type: LEAD_EVENT.disputed, clientUserId: session.userId, requestId, payload: { dispute_id: disputeId, reason: parsed.value.reason, client_id: session.clientId } });
          await writeAudit(trx, { actorType: "client_user", actorId: session.userId, action: "dispute.raised", entityType: "lead", entityId: lead.id, reason: parsed.value.reason, after: { dispute_id: disputeId, assignment_id: assignment.id, client_id: session.clientId }, requestId });
          return { ok: true, disputeId };
        });
      } catch (error) {
        // The unique index: this lead already has a dispute that was not withdrawn.
        if ((error as { code?: string }).code === "23505") return { ok: false, code: "already_disputed" };
        throw error;
      }
    },

    /** The business takes a dispute back while it is still undecided. The lead returns to `accepted`; nothing is refunded. */
    async withdraw(session: ClientSession, disputeId: string, requestId: string): Promise<DisputeResult> {
      if (!/^[0-9a-f-]{36}$/i.test(disputeId)) return { ok: false, code: "not_found" };
      const peek = await peekDispute(db, disputeId);
      if (!peek || peek.clientId !== session.clientId) return { ok: false, code: "not_found" };
      return db.transaction().execute(async (trx): Promise<DisputeResult> => {
        const lead = await lockLead(trx, peek.leadId);
        const assignment = await lockAssignment(trx, peek.assignmentId);
        const dispute = await lockDispute(trx, disputeId);
        if (!lead || !assignment || !dispute || dispute.clientId !== session.clientId) return { ok: false, code: "not_found" };
        if (dispute.status !== "open" && dispute.status !== "under_review") return { ok: false, code: "not_open" };
        if (assignment.status !== "disputed") return { ok: false, code: "inconsistent" };
        await setClientContext(trx, { clientUserId: session.userId, reason: "dispute_withdrawn", requestId });
        await markWithdrawn(trx, dispute.id);
        if (!(await transitionAssignment(trx, assignment.id, "disputed", "accepted"))) return { ok: false, code: "inconsistent" };
        await writeAudit(trx, { actorType: "client_user", actorId: session.userId, action: "dispute.withdrawn", entityType: "lead", entityId: lead.id, after: { dispute_id: dispute.id, assignment_id: assignment.id }, requestId });
        return { ok: true };
      });
    },

    forBusiness(session: ClientSession): Promise<DisputeRow[]> {
      return withClientScope(db, session.clientId, (scoped) => listForBusiness(scoped, session.clientId, 100));
    },

    forAssignment(session: ClientSession, assignmentId: string): Promise<DisputeRow[]> {
      return withClientScope(db, session.clientId, (scoped) => listForAssignment(scoped, session.clientId, assignmentId));
    },

    // ---- staff ----

    detail: (disputeId: string) => detail(db, disputeId),
    queueFor: () => queue(db),
    openCount: () => countOpen(db),

    /**
     * Staff decide. Upheld: the assignment ends as `refunded` (the database refunds the charge, exactly once), the lead returns to `new` and routing is
     * STOPPED for it (a person decides what a lead that was reported should do next). Not upheld: the business keeps the lead and the charge.
     * The decision names the person and a code from a closed list that belongs to the outcome.
     */
    async decide(input: { operator: Operator; disputeId: string; fields: Record<string, string | undefined>; requestId: string }): Promise<DisputeResult<{ outcome: "upheld" | "rejected" }>> {
      if (!/^[0-9a-f-]{36}$/i.test(input.disputeId)) return { ok: false, code: "not_found" };
      const parsed = parseDecision(input.fields);
      if (!parsed.ok) return { ok: false, code: parsed.error };
      const decision = parsed.value;
      const peek = await peekDispute(db, input.disputeId);
      if (!peek) return { ok: false, code: "not_found" };
      return db.transaction().execute(async (trx): Promise<DisputeResult<{ outcome: "upheld" | "rejected" }>> => {
        const lead = await lockLead(trx, peek.leadId);
        const assignment = await lockAssignment(trx, peek.assignmentId);
        const dispute = await lockDispute(trx, input.disputeId);
        if (!lead || !assignment || !dispute) return { ok: false, code: "not_found" };
        if (dispute.status !== "open" && dispute.status !== "under_review") return { ok: false, code: "not_open" };
        if (assignment.status !== "disputed") return { ok: false, code: "inconsistent" };
        await setStaffContext(trx, { operatorId: input.operator.id, reason: decision.reason, requestId: input.requestId });
        if (decision.outcome === "uphold") {
          await markDecided(trx, { disputeId: dispute.id, status: "upheld", resolution: decision.resolution, operatorId: input.operator.id, decisionReason: decision.reason });
          if (!(await transitionAssignment(trx, assignment.id, "disputed", "refunded"))) return { ok: false, code: "inconsistent" };
          if ((await activeAssignmentsForLead(trx, lead.id)).length === 0 && lead.status === "assigned") {
            await transitionLead(trx, lead.id, "assigned", "new");
            await insertLeadEvent(trx, { leadId: lead.id, type: LEAD_EVENT.routingStopped, operatorId: input.operator.id, requestId: input.requestId, payload: { reason: "dispute_upheld", dispute_id: dispute.id } });
          }
        } else {
          await markDecided(trx, { disputeId: dispute.id, status: "rejected", resolution: null, operatorId: input.operator.id, decisionReason: decision.reason });
          if (!(await transitionAssignment(trx, assignment.id, "disputed", "accepted"))) return { ok: false, code: "inconsistent" };
        }
        const outcome = decision.outcome === "uphold" ? "upheld" : "rejected";
        await insertLeadEvent(trx, { leadId: lead.id, type: LEAD_EVENT.disputeDecided, operatorId: input.operator.id, requestId: input.requestId, payload: { dispute_id: dispute.id, outcome, decision: decision.reason } });
        await writeAudit(trx, {
          actorId: input.operator.id, action: `dispute.${outcome}`, entityType: "lead", entityId: lead.id, reason: decision.reason,
          before: { dispute_id: dispute.id, status: dispute.status }, after: { assignment_id: assignment.id, resolution: decision.outcome === "uphold" ? decision.resolution : null, outcome, label: DISPUTE_DECISION_REASONS[decision.reason].outcome },
          requestId: input.requestId,
        });
        return { ok: true, outcome };
      });
    },
  };
}

export type DisputeService = ReturnType<typeof createDisputeService>;
