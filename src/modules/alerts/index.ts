/**
 * Public surface of the alerts module. Other modules import from here, never from ./repo.
 *
 * Stage 2: tells an operator about every lead that needs a human. The alert row is written in the
 * lead's own transaction (see enqueueOperatorAlert), delivered by the worker, and protected from
 * every failure by a lease, retries with backoff, a reconciler and /api/pipeline.
 */
import type { Database } from "@/lib/db/client";
import type { LeadStatus } from "@/lib/db/schema";
import { enqueueAlert, notifyAlertsDue } from "./repo";

export { MAX_ALERT_ATTEMPTS, retryDelayMs } from "./backoff";
export { buildAlertMessage, type AlertLeadContext, type AlertMessageOptions } from "./message";
export type { EmailMessage, EmailSender, SendResult } from "./ports";
export { ALERTS_CHANNEL, getPipelineHealth, recordHeartbeat, removeWorkerHeartbeat, pruneHeartbeats, type PipelineHealth, type PipelineProblem } from "./repo";
export {
  createAlertService,
  IDEMPOTENCY_MISMATCH_CODE,
  type AlertService,
  type AlertServiceConfig,
  type AlertServiceDeps,
  type ProcessSummary,
  type ReconcileSummary,
} from "./service";

/**
 * Called inside the lead-creation transaction. Leads that a human must look at (`new`, `held`) get an
 * alert; screened-out ones (`duplicate`, `rejected_fraud`) do not. Because it commits or rolls back
 * with the lead, "lead stored, nobody told" cannot happen, and NOTIFY (delivered at COMMIT) wakes
 * the worker in milliseconds.
 */
export async function enqueueOperatorAlert(db: Database, lead: { id: string; status: LeadStatus }): Promise<void> {
  if (lead.status !== "new" && lead.status !== "held") return;
  await enqueueAlert(db, { leadId: lead.id, kind: lead.status === "held" ? "held_lead" : "new_lead" });
  await notifyAlertsDue(db);
}
