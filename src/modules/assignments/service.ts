import type { Logger } from "pino";
import { CANCEL_REASON_CODES, STOP_ROUTING_REASONS } from "@/config/assignment";
import { LEAD_EVENT } from "@/config/lead-events";
import { setStaffContext } from "@/lib/db/audit-context";
import type { Database } from "@/lib/db/client";
import { writeAudit } from "@/modules/audit";
import { explainCoverage, type ClientVerdict, type NotEligibleReason } from "@/modules/coverage";
import type { Operator } from "@/modules/inbox";
import { resolvePrice } from "@/modules/pricing";
import { buildHandoverMessage } from "./message";
import {
  activeAssignmentsForLead,
  assignmentsForLead,
  commitExclusive,
  consentState,
  insertAssignment,
  insertLeadEvent,
  loadHandover,
  lockAssignment,
  lockLead,
  transitionAssignment,
  transitionLead,
  type AssignmentRow,
  type LeadAssignmentView,
  type LeadForAssignment,
} from "./repo";

export type AssignmentFailure =
  | "not_found"
  | "lead_erased"
  | "lead_held"
  | "already_assigned"
  | "lead_not_assignable"
  | "consent_withdrawn"
  | "no_consent_to_share"
  | "suppressed"
  | "client_not_found"
  | "client_not_active"
  | "not_covered"
  | "price_required"
  | "invalid_reason"
  | "same_client"
  | "not_cancellable"
  | "not_notifiable";

export interface AssignmentFailureResult {
  ok: false;
  code: AssignmentFailure;
  /** why the client is not eligible, when code = not_covered */
  reasons?: NotEligibleReason[];
}
export type AssignmentResult<T = object> = ({ ok: true } & T) | AssignmentFailureResult;

export interface AssignmentServiceDeps {
  db: Database;
  logger: Logger;
  brandName: string;
  /** Has the consumer behind this lead asked us to stop since they enquired? (Implemented by the privacy module.) */
  isSuppressed: (db: Database, leadId: string) => Promise<boolean>;
}

interface Pricing {
  pricePence: number;
  pricingRuleId: string | null;
}

export interface Candidates {
  reference: string;
  postcode: string | null;
  /** Active clients, eligible ones first. */
  clients: ClientVerdict[];
  /** The price the pricing rules give this lead, if any: when absent the operator must supply one. */
  price: { pricePence: number } | undefined;
}

/** Database errors that mean "the guard said no" (see migration 0003), mapped to a typed failure instead of a 500. */
function mapGuardError(error: unknown): AssignmentFailure | undefined {
  const { code, message = "", constraint = "" } = error as { code?: string; message?: string; constraint?: string };
  if (code === "23505" && constraint.startsWith("lead_assignments_one_active")) return "already_assigned";
  if (code === "23514") {
    if (message.includes("withdrawn")) return "consent_withdrawn";
    if (message.includes("no consent to be shared")) return "no_consent_to_share";
    if (message.includes("erased or deleted")) return "lead_erased";
  }
  return undefined;
}

export function createAssignmentService(deps: AssignmentServiceDeps) {
  const { db, logger } = deps;

  /** Everything that must be true before a business may hold a lead. Runs inside the transaction, after the lead is locked. */
  async function admit(
    trx: Database,
    lead: LeadForAssignment,
    clientId: string,
    options: { coverageException: boolean; manualPricePence?: number | undefined },
  ): Promise<AssignmentResult<Pricing & { outsideCoverage: boolean }>> {
    const consent = await consentState(trx, lead.id);
    if (consent.withdrawn) return { ok: false, code: "consent_withdrawn" };
    if ((consent.maxRecipients ?? 0) < 1) return { ok: false, code: "no_consent_to_share" };
    if (await deps.isSuppressed(trx, lead.id)) return { ok: false, code: "suppressed" };

    // The client row is share-locked: it cannot be paused, or lose its last rule, while we assign to it.
    const client = await trx.selectFrom("clients").select(["id", "status"]).where("id", "=", clientId).where("deleted_at", "is", null).forShare().executeTakeFirst();
    if (!client) return { ok: false, code: "client_not_found" };
    if (client.status !== "active") return { ok: false, code: "client_not_active" };

    if (!lead.postcode) return { ok: false, code: "lead_erased" };
    const coverage = await explainCoverage(trx, { postcode: lead.postcode, verticalId: lead.verticalId, serviceTypeId: lead.serviceTypeId, saleType: "exclusive" }, { clientId });
    const verdict = coverage.status === "ok" ? coverage.clients[0] : undefined;
    const outsideCoverage = !verdict?.eligible;
    if (outsideCoverage && !options.coverageException) return { ok: false, code: "not_covered", reasons: verdict?.reasons ?? ["no_include_rule_matches"] };

    const rule = await resolvePrice(trx, { verticalId: lead.verticalId, serviceTypeId: lead.serviceTypeId, postcodeOutward: lead.postcodeOutward, urgency: lead.urgency, saleType: "exclusive" });
    if (rule) return { ok: true, pricePence: rule.pricePence, pricingRuleId: rule.ruleId, outsideCoverage };
    if (options.manualPricePence === undefined) return { ok: false, code: "price_required" };
    return { ok: true, pricePence: options.manualPricePence, pricingRuleId: null, outsideCoverage };
  }

  function leadGate(lead: LeadForAssignment | undefined, mode: "new" | "assigned"): AssignmentFailureResult | undefined {
    if (!lead) return { ok: false, code: "not_found" };
    if (lead.erased || lead.deleted) return { ok: false, code: "lead_erased" };
    if (mode === "new") {
      if (lead.status === "assigned") return { ok: false, code: "already_assigned" };
      if (lead.status === "held") return { ok: false, code: "lead_held" };
      // `unroutable` is exactly the lead an operator wants to hand over by hand: the router found nobody.
      if (lead.status !== "new" && lead.status !== "unroutable") return { ok: false, code: "lead_not_assignable" };
    } else if (lead.status !== "assigned") {
      return { ok: false, code: "not_cancellable" };
    }
    return undefined;
  }

  async function guarded<T>(work: () => Promise<AssignmentResult<T>>): Promise<AssignmentResult<T>> {
    try {
      return await work();
    } catch (error) {
      const mapped = mapGuardError(error);
      if (mapped) return { ok: false, code: mapped };
      throw error;
    }
  }

  return {
    /** Who could take this lead, and at what price: what the operator sees on the lead page. */
    async candidates(leadId: string): Promise<Candidates | undefined> {
      const lead = await db.selectFrom("leads").select(["id", "reference", "postcode", "postcode_outward", "vertical_id", "service_type_id", "urgency"]).where("id", "=", leadId).where("deleted_at", "is", null).executeTakeFirst();
      if (!lead) return undefined;
      const price = await resolvePrice(db, { verticalId: lead.vertical_id, serviceTypeId: lead.service_type_id, postcodeOutward: lead.postcode_outward, urgency: lead.urgency, saleType: "exclusive" });
      if (!lead.postcode) return { reference: lead.reference, postcode: null, clients: [], price: price && { pricePence: price.pricePence } };
      const coverage = await explainCoverage(db, { postcode: lead.postcode, verticalId: lead.vertical_id, serviceTypeId: lead.service_type_id, saleType: "exclusive" });
      const clients = coverage.status === "ok" ? coverage.clients.filter((client) => client.status === "active").sort((a, b) => Number(b.eligible) - Number(a.eligible)) : [];
      return { reference: lead.reference, postcode: lead.postcode, clients, price: price && { pricePence: price.pricePence } };
    },

    forLead(leadId: string): Promise<LeadAssignmentView[]> {
      return assignmentsForLead(db, leadId);
    },

    /** Hands a NEW lead to one business. The lead row is locked first, so simultaneous attempts queue and exactly one wins. */
    async assign(input: {
      operator: Operator;
      leadId: string;
      clientId: string;
      /** The operator confirms they know the business does not cover this postcode. Recorded in the history and audit. */
      coverageException?: boolean;
      /** Required only when no pricing rule matches. Ignored when one does (change the rule, not the lead). */
      manualPricePence?: number;
      requestId: string;
    }): Promise<AssignmentResult<{ assignmentId: string; pricePence: number; outsideCoverage: boolean }>> {
      const result = await guarded(() =>
        db.transaction().execute(async (trx): Promise<AssignmentResult<{ assignmentId: string; pricePence: number; outsideCoverage: boolean }>> => {
          const lead = await lockLead(trx, input.leadId);
          const blocked = leadGate(lead, "new");
          if (blocked || !lead) return blocked ?? { ok: false, code: "not_found" };
          const admitted = await admit(trx, lead, input.clientId, { coverageException: input.coverageException ?? false, manualPricePence: input.manualPricePence });
          if (!admitted.ok) return admitted;

          const reason = admitted.outsideCoverage ? "coverage_exception" : "manual_assignment";
          await setStaffContext(trx, { operatorId: input.operator.id, reason, requestId: input.requestId });
          await commitExclusive(trx, lead.id);
          const assignmentId = await insertAssignment(trx, { leadId: lead.id, clientId: input.clientId, operatorId: input.operator.id, pricePence: admitted.pricePence, pricingRuleId: admitted.pricingRuleId });
          if (!(await transitionLead(trx, lead.id, lead.status, "assigned"))) throw new Error("lead changed status while locked");
          await writeAudit(trx, {
            actorId: input.operator.id,
            action: "assignment.created",
            entityType: "lead",
            entityId: lead.id,
            reason,
            after: { assignment_id: assignmentId, client_id: input.clientId, price_pence: admitted.pricePence, pricing_rule_id: admitted.pricingRuleId, outside_coverage: admitted.outsideCoverage, reference: lead.reference },
            requestId: input.requestId,
          });
          return { ok: true, assignmentId, pricePence: admitted.pricePence, outsideCoverage: admitted.outsideCoverage };
        }),
      );
      logger.info({ leadId: input.leadId, clientId: input.clientId, operatorId: input.operator.id, ok: result.ok, code: result.ok ? undefined : result.code }, "lead assignment");
      return result;
    },

    /** Records that the operator has sent the lead to the business (reserved -> notified). */
    async markSent(input: { operator: Operator; assignmentId: string; requestId: string }): Promise<AssignmentResult> {
      return guarded(() =>
        db.transaction().execute(async (trx): Promise<AssignmentResult> => {
          const found = await lockAssignmentWithLead(trx, input.assignmentId);
          if (!found) return { ok: false, code: "not_found" };
          if (found.assignment.status !== "reserved") return { ok: false, code: "not_notifiable" };
          await setStaffContext(trx, { operatorId: input.operator.id, reason: "marked_sent", requestId: input.requestId });
          if (!(await transitionAssignment(trx, found.assignment.id, "reserved", "notified"))) return { ok: false, code: "not_notifiable" };
          await writeAudit(trx, { actorId: input.operator.id, action: "assignment.notified", entityType: "lead", entityId: found.assignment.leadId, after: { assignment_id: found.assignment.id, client_id: found.assignment.clientId }, requestId: input.requestId });
          return { ok: true };
        }),
      );
    },

    /** Takes a lead back from a business. The lead returns to `new` (unless another assignment is active). Reason is mandatory. */
    async cancel(input: { operator: Operator; assignmentId: string; reason: string; requestId: string }): Promise<AssignmentResult> {
      if (!(CANCEL_REASON_CODES as readonly string[]).includes(input.reason)) return { ok: false, code: "invalid_reason" };
      return guarded(() =>
        db.transaction().execute(async (trx): Promise<AssignmentResult> => {
          const found = await lockAssignmentWithLead(trx, input.assignmentId);
          if (!found) return { ok: false, code: "not_found" };
          if (found.assignment.status !== "reserved" && found.assignment.status !== "notified") return { ok: false, code: "not_cancellable" };
          await setStaffContext(trx, { operatorId: input.operator.id, reason: input.reason, requestId: input.requestId });
          if (!(await transitionAssignment(trx, found.assignment.id, found.assignment.status, "cancelled"))) return { ok: false, code: "not_cancellable" };
          if ((await activeAssignmentsForLead(trx, found.lead.id)).length === 0 && found.lead.status === "assigned") {
            await transitionLead(trx, found.lead.id, "assigned", "new");
            // Some reasons mean a PERSON should decide what happens next: the router must not pick the lead up again by itself.
            if ((STOP_ROUTING_REASONS as readonly string[]).includes(input.reason)) {
              await insertLeadEvent(trx, { leadId: found.lead.id, type: LEAD_EVENT.routingStopped, operatorId: input.operator.id, requestId: input.requestId, payload: { reason: input.reason } });
            }
          }
          await writeAudit(trx, { actorId: input.operator.id, action: "assignment.cancelled", entityType: "lead", entityId: found.lead.id, reason: input.reason, before: { assignment_id: found.assignment.id, client_id: found.assignment.clientId, status: found.assignment.status }, requestId: input.requestId });
          return { ok: true };
        }),
      );
    },

    /** Moves a lead from one business to another in one transaction: the old assignment ends (reason mandatory) and a new one begins. */
    async reassign(input: {
      operator: Operator;
      assignmentId: string;
      toClientId: string;
      reason: string;
      coverageException?: boolean;
      manualPricePence?: number;
      requestId: string;
    }): Promise<AssignmentResult<{ assignmentId: string; pricePence: number; outsideCoverage: boolean }>> {
      if (!(CANCEL_REASON_CODES as readonly string[]).includes(input.reason)) return { ok: false, code: "invalid_reason" };
      return guarded(() =>
        db.transaction().execute(async (trx): Promise<AssignmentResult<{ assignmentId: string; pricePence: number; outsideCoverage: boolean }>> => {
          const found = await lockAssignmentWithLead(trx, input.assignmentId);
          if (!found) return { ok: false, code: "not_found" };
          if (found.assignment.status !== "reserved" && found.assignment.status !== "notified") return { ok: false, code: "not_cancellable" };
          if (found.assignment.clientId === input.toClientId) return { ok: false, code: "same_client" };
          if (found.lead.erased || found.lead.deleted) return { ok: false, code: "lead_erased" };

          const admitted = await admit(trx, found.lead, input.toClientId, { coverageException: input.coverageException ?? false, manualPricePence: input.manualPricePence });
          if (!admitted.ok) return admitted;

          await setStaffContext(trx, { operatorId: input.operator.id, reason: input.reason, requestId: input.requestId });
          if (!(await transitionAssignment(trx, found.assignment.id, found.assignment.status, "cancelled"))) return { ok: false, code: "not_cancellable" };
          const assignmentId = await insertAssignment(trx, { leadId: found.lead.id, clientId: input.toClientId, operatorId: input.operator.id, pricePence: admitted.pricePence, pricingRuleId: admitted.pricingRuleId });
          await writeAudit(trx, {
            actorId: input.operator.id,
            action: "assignment.reassigned",
            entityType: "lead",
            entityId: found.lead.id,
            reason: input.reason,
            before: { assignment_id: found.assignment.id, client_id: found.assignment.clientId, price_pence: found.assignment.pricePence },
            after: { assignment_id: assignmentId, client_id: input.toClientId, price_pence: admitted.pricePence, outside_coverage: admitted.outsideCoverage, reference: found.lead.reference },
            requestId: input.requestId,
          });
          return { ok: true, assignmentId, pricePence: admitted.pricePence, outsideCoverage: admitted.outsideCoverage };
        }),
      );
    },

    /** The text to send to the business (consumer details included). Undefined if the assignment is not active or the lead was erased. */
    async handover(assignmentId: string): Promise<{ subject: string; text: string; to: string } | undefined> {
      const data = await loadHandover(db, assignmentId);
      if (!data) return undefined;
      const client = await db.selectFrom("lead_assignments as a").innerJoin("clients as c", "c.id", "a.client_id").select("c.contact_email").where("a.id", "=", assignmentId).executeTakeFirst();
      return { ...buildHandoverMessage(data, deps.brandName), to: client?.contact_email ?? "" };
    },
  };

  /** Lock order is ALWAYS lead, then assignment: two operators acting on one lead queue up at the lead and never deadlock. */
  async function lockAssignmentWithLead(trx: Database, assignmentId: string): Promise<{ assignment: AssignmentRow; lead: LeadForAssignment } | undefined> {
    const peek = await trx.selectFrom("lead_assignments").select("lead_id").where("id", "=", assignmentId).executeTakeFirst();
    if (!peek) return undefined;
    const lead = await lockLead(trx, peek.lead_id);
    const assignment = await lockAssignment(trx, assignmentId);
    return lead && assignment ? { assignment, lead } : undefined;
  }
}

export type AssignmentService = ReturnType<typeof createAssignmentService>;
