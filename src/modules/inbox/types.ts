import type { FraudDecision, LeadStatus, OperatorAlertKind, OperatorAlertStatus, UrgencyLevel } from "@/lib/db/schema";

/** The staff member performing an action, as established by the web layer (never taken from request input). */
export interface Operator {
  id: string;
  email: string;
  /** `owner` may also do the destructive privacy actions. Derived from configuration, never from the database. */
  role: "owner" | "staff";
}

/** Which slice of leads the inbox shows. */
export type InboxView = "open" | "handled" | "assigned" | "screened";
export const INBOX_VIEWS: readonly InboxView[] = ["open", "handled", "assigned", "screened"];

export interface InboxRow {
  id: string;
  reference: string;
  receivedAt: Date;
  status: LeadStatus;
  serviceLabel: string;
  postcodeOutward: string;
  urgency: UrgencyLevel;
  fraudScore: number;
  fraudDecision: FraudDecision;
  handled: boolean;
  /** Assigned to a business but not yet sent to them: someone still has to send it. */
  unsent: boolean;
  /** State of the first alert for this lead: tells the operator whether the email can be trusted to have gone out. */
  alert: OperatorAlertStatus | "none";
}

export interface TimelineEntry {
  at: Date;
  /** "event" rows come from lead_events, "status" rows from lead_status_history. */
  source: "event" | "status";
  text: string;
  /** Who caused it: "system", "consumer", or an operator's email. */
  actor: string;
}

export interface LeadDetail extends InboxRow {
  /** The full postcode and every personal field. Null contact = erased. */
  postcode: string | null;
  propertyType: string;
  ownership: string;
  scope: string | null;
  contact: { name: string; phone: string; email: string; notes: string | null } | null;
  consent: { version: string; capturedAt: Date; withdrawnAt: Date | null } | null;
  /** The consumer's personal data has been erased (the contact fields are null). */
  erased: boolean;
  attribution: { source: string | null; medium: string | null; campaign: string | null; landingPath: string | null } | null;
  signals: Array<{ code: string; weight: number }>;
  alerts: Array<{ kind: OperatorAlertKind; status: OperatorAlertStatus; attempts: number; sentAt: Date | null; errorCode: string | null }>;
  timeline: TimelineEntry[];
  duplicateOfReference: string | null;
}

export type ActionFailure = "not_found" | "not_held" | "not_open" | "invalid_reason";
export type ActionResult = { ok: true; alreadyDone?: boolean } | { ok: false; code: ActionFailure };
