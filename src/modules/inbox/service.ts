import type { Logger } from "pino";
import { LEAD_EVENT } from "@/config/lead-events";
import { APPROVE_REASON_CODES, REJECT_REASON_CODES } from "@/config/review";
import type { Database } from "@/lib/db/client";
import {
  countView,
  getLeadDetail,
  insertOperatorEvent,
  isHandled,
  leadStatus,
  listLeads,
  lockLeadStatus,
  setStaffContext,
  transitionHeldLead,
} from "./repo";
import type { ActionResult, InboxRow, InboxView, LeadDetail, Operator } from "./types";

export interface InboxServiceDeps {
  db: Database;
  logger: Logger;
}

export interface InboxService {
  /** `total` is the true size of the view (rows may be fewer: the page is capped, newest kept); `openCount` feeds the tab badge. */
  list(view: InboxView): Promise<{ rows: InboxRow[]; total: number; openCount: number }>;
  detail(leadId: string): Promise<LeadDetail | undefined>;
  /** held -> new. The lead then waits for a human like any other new lead. */
  approve(input: { operator: Operator; leadId: string; reason: string; requestId: string }): Promise<ActionResult>;
  /** held -> rejected_fraud. */
  reject(input: { operator: Operator; leadId: string; reason: string; requestId: string }): Promise<ActionResult>;
  /** Records that a human dealt with a new lead (e.g. passed it on). Idempotent. */
  markHandled(input: { operator: Operator; leadId: string; requestId: string }): Promise<ActionResult>;
}

export function createInboxService({ db, logger }: InboxServiceDeps): InboxService {
  async function decide(
    kind: "approve" | "reject",
    input: { operator: Operator; leadId: string; reason: string; requestId: string },
  ): Promise<ActionResult> {
    const allowed: readonly string[] = kind === "approve" ? APPROVE_REASON_CODES : REJECT_REASON_CODES;
    if (!allowed.includes(input.reason)) return { ok: false, code: "invalid_reason" };

    const result = await db.transaction().execute(async (trx): Promise<ActionResult> => {
      await setStaffContext(trx, { operatorId: input.operator.id, reason: input.reason, requestId: input.requestId });
      const moved = await transitionHeldLead(trx, input.leadId, kind === "approve" ? "new" : "rejected_fraud");
      if (!moved) {
        // Lost the race, or the lead was never held. Say which, without changing anything.
        const status = await leadStatus(trx, input.leadId);
        return { ok: false, code: status === undefined ? "not_found" : "not_held" };
      }
      await insertOperatorEvent(trx, {
        leadId: input.leadId,
        operatorId: input.operator.id,
        requestId: input.requestId,
        type: kind === "approve" ? LEAD_EVENT.reviewApproved : LEAD_EVENT.reviewRejected,
        payload: { reason: input.reason },
      });
      return { ok: true };
    });

    // Ids and codes only: never the operator's email, never anything about the consumer.
    logger.info(
      { leadId: input.leadId, operatorId: input.operator.id, decision: kind, reason: input.reason, ok: result.ok, code: result.ok ? undefined : result.code },
      "held lead decision",
    );
    return result;
  }

  return {
    async list(view) {
      const [rows, total, openCount] = await Promise.all([
        listLeads(db, view),
        countView(db, view),
        view === "open" ? undefined : countView(db, "open"),
      ]);
      return { rows, total, openCount: openCount ?? total };
    },
    detail: (leadId) => getLeadDetail(db, leadId),
    approve: (input) => decide("approve", input),
    reject: (input) => decide("reject", input),

    async markHandled(input) {
      const result = await db.transaction().execute(async (trx): Promise<ActionResult> => {
        const status = await lockLeadStatus(trx, input.leadId);
        if (status === undefined) return { ok: false, code: "not_found" };
        // Held leads are decided, not "handled". `unroutable` can be: it is the lead nobody automatic could take, so a person deals with it.
        if (status !== "new" && status !== "unroutable") return { ok: false, code: "not_open" };
        if (await isHandled(trx, input.leadId)) return { ok: true, alreadyDone: true };
        await insertOperatorEvent(trx, { leadId: input.leadId, operatorId: input.operator.id, requestId: input.requestId, type: LEAD_EVENT.handled });
        return { ok: true };
      });
      logger.info({ leadId: input.leadId, operatorId: input.operator.id, ok: result.ok }, "lead marked handled");
      return result;
    },
  };
}
