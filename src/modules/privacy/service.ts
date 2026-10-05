import type { Logger } from "pino";
import { ERASE_REASON_CODES } from "@/config/privacy";
import { LEAD_EVENT } from "@/config/lead-events";
import { setStaffContext, setSystemContext } from "@/lib/db/audit-context";
import type { Database } from "@/lib/db/client";
import type { LeadStatus } from "@/lib/db/schema";
import { activeAssignmentsForLead, transitionAssignment } from "@/modules/assignments";
import { writeAudit } from "@/modules/audit";
import type { Operator } from "@/modules/inbox";
import {
  blankPersonalData,
  hasWithdrawal,
  holders,
  insertSuppressions,
  insertWithdrawal,
  lockLeadForPrivacy,
  readIdentity,
  suppressedSince,
  type HolderNotice,
  type LeadForPrivacy,
} from "./repo";
import { suppressionHmac } from "./suppression";

export type PrivacyFailure = "not_found" | "forbidden" | "invalid_reason" | "no_consent_record";
export type PrivacyResult = { ok: true; alreadyDone: boolean; notify: HolderNotice[] } | { ok: false; code: PrivacyFailure };

export interface PrivacyServiceDeps {
  db: Database;
  logger: Logger;
  /** PRIVACY_HASH_KEY. */
  hashKey: string;
}

/** Statuses a lead leaves for `invalid` when its consumer withdraws consent or is erased (all are legal transitions). */
const RETIRABLE: readonly LeadStatus[] = ["new", "held", "unroutable"];

type Actor = { kind: "staff"; operator: Operator } | { kind: "system" };

export function createPrivacyService({ db, logger, hashKey }: PrivacyServiceDeps) {
  const identityKeys = (identity: { phone: string; email: string }) => [
    { kind: "phone" as const, hmac: suppressionHmac(hashKey, "phone", identity.phone) },
    { kind: "email" as const, hmac: suppressionHmac(hashKey, "email", identity.email) },
  ];

  /** Ends the holds that can be ended by hand and returns every business that has the details (they are separate controllers). */
  async function releaseHolders(trx: Database, lead: LeadForPrivacy): Promise<HolderNotice[]> {
    const notices = await holders(trx, lead.id);
    for (const holder of notices) {
      if (holder.status === "reserved" || holder.status === "notified") {
        await transitionAssignment(trx, holder.assignmentId, holder.status, "cancelled"); // history: actor + reason from the context set by the caller
      }
    }
    const remaining = await activeAssignmentsForLead(trx, lead.id);
    if (remaining.length === 0 && lead.status === "assigned") {
      await trx.updateTable("leads").set({ status: "invalid" }).where("id", "=", lead.id).where("status", "=", "assigned").execute();
    } else if (RETIRABLE.includes(lead.status)) {
      await trx.updateTable("leads").set({ status: "invalid" }).where("id", "=", lead.id).where("status", "=", lead.status).execute();
    }
    return notices;
  }

  async function context(trx: Database, actor: Actor, reason: string, requestId: string) {
    if (actor.kind === "staff") await setStaffContext(trx, { operatorId: actor.operator.id, reason, requestId });
    else await setSystemContext(trx, { requestId, reason });
  }

  async function erase(input: { actor: Actor; leadId: string; reason: string; requestId: string }): Promise<PrivacyResult> {
    if (input.actor.kind === "staff" && input.actor.operator.role !== "owner") return { ok: false, code: "forbidden" };
    if (input.actor.kind === "staff" && !(ERASE_REASON_CODES as readonly string[]).includes(input.reason)) return { ok: false, code: "invalid_reason" };

    const result = await db.transaction().execute(async (trx): Promise<PrivacyResult> => {
      const lead = await lockLeadForPrivacy(trx, input.leadId);
      if (!lead) return { ok: false, code: "not_found" };
      if (lead.erased) return { ok: true, alreadyDone: true, notify: await holders(trx, lead.id) };

      await context(trx, input.actor, "erasure_request", input.requestId);
      // The keyed hashes must be taken BEFORE the personal data is blanked: afterwards there is nothing left to hash.
      const identity = await readIdentity(trx, lead.id);
      if (identity) await insertSuppressions(trx, identityKeys(identity), "erasure");
      const notify = await releaseHolders(trx, lead);
      await blankPersonalData(trx, lead.id);

      const actorFields = input.actor.kind === "staff" ? { actorId: input.actor.operator.id } : { actorId: null, actorType: "system" as const };
      await trx.insertInto("lead_events").values({
        lead_id: lead.id,
        type: LEAD_EVENT.erased,
        actor_type: input.actor.kind === "staff" ? "staff_user" : "system",
        actor_id: input.actor.kind === "staff" ? input.actor.operator.id : null,
        request_id: input.requestId,
        payload: JSON.stringify({ reason: input.reason }),
      }).execute();
      await writeAudit(trx, { ...actorFields, action: "privacy.lead_erased", entityType: "lead", entityId: lead.id, reason: input.reason, after: { reference: lead.reference, notified_clients: notify.map((holder) => holder.clientId) }, requestId: input.requestId });
      return { ok: true, alreadyDone: false, notify };
    });

    // A log line of IDS ONLY, at warn level so it is retained: after a backup restore, the erasures made since the backup are
    // re-applied from these (scripts/replay-erasures.ts). The database cannot remember them: a restore rolls it back too.
    if (result.ok && !result.alreadyDone) logger.warn({ leadId: input.leadId, action: "lead_erased", reason: input.reason, actor: input.actor.kind }, "privacy: lead erased");
    return result;
  }

  return {
    erase: (input: { operator: Operator; leadId: string; reason: string; requestId: string }) => erase({ ...input, actor: { kind: "staff", operator: input.operator } }),

    /** Re-applies an erasure after a restore. Idempotent; recorded as the system's, not a person's. */
    replayErasure: (input: { leadId: string; requestId: string }) => erase({ ...input, reason: "consumer_request", actor: { kind: "system" } }),

    /**
     * The consumer withdraws consent: recorded as an append-only consent event, the identity suppressed, the lead taken out of play,
     * and any business holding it listed so the operator can tell them to stop. Any operator may do this (it must be quick and easy).
     */
    async withdrawConsent(input: { operator: Operator; leadId: string; requestId: string }): Promise<PrivacyResult> {
      const result = await db.transaction().execute(async (trx): Promise<PrivacyResult> => {
        const lead = await lockLeadForPrivacy(trx, input.leadId);
        if (!lead) return { ok: false, code: "not_found" };
        if (lead.erased || (await hasWithdrawal(trx, lead.id))) return { ok: true, alreadyDone: true, notify: await holders(trx, lead.id) };

        await setStaffContext(trx, { operatorId: input.operator.id, reason: "consent_withdrawn", requestId: input.requestId });
        if (!(await insertWithdrawal(trx, lead.id))) return { ok: false, code: "no_consent_record" };
        const identity = await readIdentity(trx, lead.id);
        if (identity) await insertSuppressions(trx, identityKeys(identity), "withdrawn_consent");
        const notify = await releaseHolders(trx, lead);

        await trx.insertInto("lead_events").values({ lead_id: lead.id, type: LEAD_EVENT.consentWithdrawn, actor_type: "staff_user", actor_id: input.operator.id, request_id: input.requestId, payload: "{}" }).execute();
        await writeAudit(trx, { actorId: input.operator.id, action: "privacy.consent_withdrawn", entityType: "lead", entityId: lead.id, after: { reference: lead.reference, notified_clients: notify.map((holder) => holder.clientId) }, requestId: input.requestId });
        return { ok: true, alreadyDone: false, notify };
      });
      if (result.ok && !result.alreadyDone) logger.warn({ leadId: input.leadId, action: "consent_withdrawn" }, "privacy: consent withdrawn");
      return result;
    },

    /**
     * Has this consumer asked us to stop SINCE they made this enquiry? A suppression made BEFORE the enquiry does not count: a person
     * who later enquires again has given fresh consent. Used before any business is given the lead.
     */
    async isSuppressed(handle: Database, leadId: string): Promise<boolean> {
      const lead = await handle.selectFrom("leads").select("created_at").where("id", "=", leadId).executeTakeFirst();
      if (!lead) return false;
      const identity = await readIdentity(handle, leadId);
      return identity ? suppressedSince(handle, identityKeys(identity), lead.created_at) : false;
    },

    /** Who currently holds this lead (for the lead page). */
    holders: (leadId: string) => holders(db, leadId),
  };
}

export type PrivacyService = ReturnType<typeof createPrivacyService>;
