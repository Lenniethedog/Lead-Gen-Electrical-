import type { Logger } from "pino";
import { CONSENT_CODE } from "@/config/consent";
import {
  ChallengeFailedError,
  ConsentOutdatedError,
  IdempotencyConflictError,
  OutOfAreaError,
  PostcodeNotFoundError,
  ValidationError,
} from "@/lib/errors";
import { fingerprint } from "@/lib/hash";
import { generateLeadReference } from "@/lib/ids";
import type { Database } from "@/lib/db/client";
import type { LeadStatus } from "@/lib/db/schema";
import { enqueueOperatorAlert } from "@/modules/alerts";
import { classifySource } from "@/modules/attribution";
import { findActiveConsentText } from "@/modules/consent";
import {
  assess,
  collectHistorySignals,
  collectRequestSignals,
  type ChallengeVerifier,
  type FraudAssessment,
  type FraudDecision,
} from "@/modules/fraud";
import type { PostcodeService } from "@/modules/postcodes";
import type { ReferenceDataProvider } from "@/modules/reference";
import {
  findByIdempotencyKey,
  findDuplicate,
  insertAttribution,
  insertConsentRecord,
  insertContact,
  insertEvents,
  insertFraudSignals,
  insertLead,
  lockIdentity,
  setAuditContext,
  type ExistingLead,
  type LeadEventInput,
} from "./repo";
import type { LeadSubmission } from "./schemas/submission";
import type { SubmitLeadCommand, SubmitLeadResult } from "./types";

export interface LeadServiceDeps {
  db: Database;
  postcodes: PostcodeService;
  reference: ReferenceDataProvider;
  challenge: ChallengeVerifier;
  logger: Logger;
  /** Slug of the vertical this deployment serves (src/config/verticals). */
  verticalSlug: string;
  /** Our own hostname, so self-referrals are not classified as "referral" traffic. */
  ownHost?: string | undefined;
}

export interface LeadService {
  submit(command: SubmitLeadCommand): Promise<SubmitLeadResult>;
}

/** The content that defines "the same submission" for idempotency (excludes per-attempt telemetry). */
function canonicalPayload(submission: LeadSubmission) {
  return {
    service: submission.service,
    postcode: submission.postcode,
    propertyType: submission.propertyType,
    ownership: submission.ownership,
    scope: submission.scope,
    urgency: submission.urgency,
    name: submission.contact.name,
    phone: submission.contact.phone.e164,
    email: submission.contact.email.toLowerCase(),
    notes: submission.contact.notes ?? null,
    consentVersion: submission.consent.textVersion,
  };
}

/**
 * Decides the lead's initial lifecycle state.
 * Precedence: a fraud rejection always wins (even if it is also a repeat); then duplicates (they
 * must not be routed); then the manual-review hold; otherwise the lead is ready to route.
 */
export function initialStatus(decision: FraudDecision, isDuplicate: boolean): LeadStatus {
  if (decision === "reject") return "rejected_fraud";
  if (isDuplicate) return "duplicate";
  if (decision === "review") return "held";
  return "new";
}

/** What the creation transaction decided: this was a retry of an earlier submission, or a new lead. */
type TransactionOutcome =
  | { kind: "replay"; existing: ExistingLead }
  | { kind: "created"; leadId: string; reference: string; status: LeadStatus; assessment: FraudAssessment };

export function createLeadService(deps: LeadServiceDeps): LeadService {
  function replay(existing: ExistingLead, payloadFingerprint: string): SubmitLeadResult {
    // Same key, different content: the client is confused or malicious. Never hand back a lead
    // that does not correspond to what was just sent.
    if (existing.payloadFingerprint !== payloadFingerprint) throw new IdempotencyConflictError();
    return { outcome: "replayed", leadId: existing.id, reference: existing.publicReference, status: existing.status };
  }

  async function submit(command: SubmitLeadCommand): Promise<SubmitLeadResult> {
    const startedAt = performance.now();
    const { submission, idempotencyKey, request } = command;
    const log = deps.logger.child({ requestId: request.requestId });
    const payloadFingerprint = fingerprint(canonicalPayload(submission));

    // 1. Retries first. A repeated submission must succeed (or conflict) without re-running the
    //    challenge: Turnstile tokens are single-use, and a retry exists precisely because the
    //    first response was lost.
    const existing = await findByIdempotencyKey(deps.db, idempotencyKey);
    if (existing) return replay(existing, payloadFingerprint);

    // 2. The consumer must have seen the wording that is currently in force.
    const consent = await findActiveConsentText(deps.db, CONSENT_CODE);
    if (!consent || consent.version !== submission.consent.textVersion) throw new ConsentOutdatedError();

    // 3. External/independent checks run in parallel: the challenge (network) and the
    //    postcode + reference lookups (database).
    const reference = await deps.reference.get(deps.verticalSlug);
    const [challenge, postcode] = await Promise.all([
      deps.challenge.verify({ token: submission.context.turnstileToken, ip: request.ip, idempotencyKey }),
      deps.postcodes.check(submission.postcode, reference.verticalId),
    ]);

    if (challenge.status === "failed") throw new ChallengeFailedError();
    if (challenge.status === "unavailable") {
      // Our side is broken or Cloudflare is down: keep accepting leads (with a penalty) but be loud.
      log.error({ reason: challenge.reason }, "turnstile verification unavailable: failing open");
    }
    if (postcode.status === "out_of_area") throw new OutOfAreaError();
    if (postcode.status !== "covered") throw new PostcodeNotFoundError();

    const serviceTypeId = reference.serviceTypeIds.get(submission.service);
    if (serviceTypeId === undefined) {
      throw new ValidationError({ service: "That service isn't available right now" });
    }

    const emailNormalised = submission.contact.email.toLowerCase();
    const phoneE164 = submission.contact.phone.e164;
    const sourceSlug = classifySource(submission.context.attribution, deps.ownHost);
    const sourceId = reference.sourceIds.get(sourceSlug) ?? reference.sourceIds.get("unknown");
    if (sourceId === undefined) throw new Error(`lead source "${sourceSlug}" is not seeded`);

    const requestSignals = collectRequestSignals({
      honeypot: submission.context.honeypot,
      elapsedMs: submission.context.elapsedMs,
      userAgent: request.userAgent,
      country: request.country,
      challenge,
      name: submission.contact.name,
      email: emailNormalised,
      phoneKind: submission.contact.phone.kind,
      notes: submission.contact.notes,
    });

    // 4. One transaction creates the lead and everything that must exist with it.
    const outcome = await deps.db.transaction().execute(async (trx): Promise<TransactionOutcome> => {
      await setAuditContext(trx, { actorType: "consumer", requestId: request.requestId });

      // Serialise this person's concurrent submissions (phone and email, in a fixed order), then
      // re-check for a retry that committed while we waited for the locks.
      await lockIdentity(trx, phoneE164, emailNormalised);
      const committed = await findByIdempotencyKey(trx, idempotencyKey);
      if (committed) return { kind: "replay", existing: committed };

      const duplicateOf = await findDuplicate(trx, {
        verticalId: reference.verticalId,
        serviceTypeId,
        postcodeOutward: postcode.outward,
        phoneE164,
        emailNormalised,
        windowDays: reference.duplicateWindowDays,
      });

      const historySignals = await collectHistorySignals(trx, { ip: request.ip, phoneE164, emailNormalised });
      const assessment: FraudAssessment = assess([...requestSignals, ...historySignals]);
      const status = initialStatus(assessment.decision, duplicateOf !== undefined);

      const inserted = await insertLead(trx, {
        reference: generateLeadReference(),
        idempotencyKey,
        payloadFingerprint,
        verticalId: reference.verticalId,
        serviceTypeId,
        sourceId,
        status,
        postcode: postcode.postcode,
        postcodeOutward: postcode.outward,
        propertyType: submission.propertyType,
        ownership: submission.ownership,
        urgency: submission.urgency,
        details: { scope: submission.scope },
        fraudScore: assessment.score,
        fraudDecision: assessment.decision,
        duplicateOfLeadId: status === "duplicate" ? (duplicateOf?.id ?? null) : null,
      });

      if (!inserted) {
        // Lost a race on the idempotency key to a request with a different phone number.
        const winner = await findByIdempotencyKey(trx, idempotencyKey);
        if (!winner) throw new Error("idempotency conflict without a committed lead");
        return { kind: "replay", existing: winner };
      }

      await insertContact(trx, inserted.id, {
        fullName: submission.contact.name,
        phoneE164,
        email: submission.contact.email,
        emailNormalised,
        notes: submission.contact.notes ?? null,
        ip: request.ip,
        userAgent: request.userAgent,
      });
      await insertConsentRecord(trx, {
        leadId: inserted.id,
        consentTextId: consent.id,
        pagePath: submission.context.pagePath ?? null,
        ip: request.ip,
        userAgent: request.userAgent,
      });
      await insertAttribution(trx, inserted.id, submission.context.attribution);
      await insertFraudSignals(trx, inserted.id, assessment.signals);

      const events: LeadEventInput[] = [
        {
          type: "lead.received",
          actorType: "consumer",
          payload: {
            source: sourceSlug,
            service: submission.service,
            postcodeOutward: postcode.outward,
            consentVersion: consent.version,
            challenge: challenge.status,
            phoneKind: submission.contact.phone.kind,
          },
        },
        {
          type: "lead.screened",
          actorType: "system",
          payload: {
            score: assessment.score,
            decision: assessment.decision,
            signals: assessment.signals.map((item) => item.code),
          },
        },
      ];
      if (duplicateOf && status === "duplicate") {
        events.push({
          type: "lead.duplicate_detected",
          actorType: "system",
          payload: { duplicateOfLeadId: duplicateOf.id },
        });
      }
      await insertEvents(trx, inserted.id, request.requestId, events);

      // Same transaction as the lead: either both exist or neither does, so a stored lead that
      // nobody was told about cannot happen. (Screened-out leads are not alerted; see the function.)
      await enqueueOperatorAlert(trx, { id: inserted.id, status });

      // A duplicate points the consumer at their ORIGINAL enquiry; anyone else gets their own reference.
      const publicReference = status === "duplicate" && duplicateOf ? duplicateOf.reference : inserted.reference;
      return { kind: "created", leadId: inserted.id, reference: publicReference, status, assessment };
    });

    if (outcome.kind === "replay") return replay(outcome.existing, payloadFingerprint);

    log.info(
      {
        leadId: outcome.leadId,
        status: outcome.status,
        fraudScore: outcome.assessment.score,
        fraudDecision: outcome.assessment.decision,
        source: sourceSlug,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "lead accepted",
    );
    return { outcome: "created", leadId: outcome.leadId, reference: outcome.reference, status: outcome.status };
  }

  return { submit };
}
