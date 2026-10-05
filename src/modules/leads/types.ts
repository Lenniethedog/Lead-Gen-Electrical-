import type { LeadStatus } from "@/lib/db/schema";
import type { LeadSubmission } from "./schemas/submission";

export interface SubmitLeadCommand {
  /** From the Idempotency-Key header. One key = at most one lead. */
  idempotencyKey: string;
  submission: LeadSubmission;
  request: {
    requestId: string;
    ip: string | null;
    country: string | null;
    userAgent: string | null;
  };
}

export type SubmitLeadResult =
  | { outcome: "created"; leadId: string; reference: string; status: LeadStatus }
  | { outcome: "replayed"; leadId: string; reference: string; status: LeadStatus };
