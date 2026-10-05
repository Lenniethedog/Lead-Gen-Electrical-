import { URGENCIES } from "@/config/lead-options";
import type { InboxRow } from "@/modules/inbox";

const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold";

/** Colour is never the only signal: every badge carries its meaning as text. */
export function StatusBadge({ status, handled, unsent = false }: { status: InboxRow["status"]; handled: boolean; /** Assigned to a business but not yet sent to them: someone still has to do that. */ unsent?: boolean }) {
  if (status === "held") return <span className={`${base} bg-amber-100 text-amber-900`}>Held for review</span>;
  if (status === "new" && handled) return <span className={`${base} bg-green-100 text-green-900`}>Handled</span>;
  if (status === "new") return <span className={`${base} bg-brand-100 text-brand-900`}>Needs action</span>;
  if (status === "unroutable") return <span className={`${base} bg-amber-100 text-amber-900`}>{handled ? "Handled" : "Nobody could take it"}</span>;
  if (status === "assigned" && unsent) return <span className={`${base} bg-brand-100 text-brand-900`}>Assigned: send it</span>;
  if (status === "assigned") return <span className={`${base} bg-indigo-100 text-indigo-900`}>Assigned</span>;
  if (status === "rejected_fraud") return <span className={`${base} bg-red-100 text-red-900`}>Rejected</span>;
  if (status === "duplicate") return <span className={`${base} bg-stone-200 text-stone-800`}>Duplicate</span>;
  return <span className={`${base} bg-stone-200 text-stone-800`}>{status.replace(/_/g, " ")}</span>;
}

export function UrgencyBadge({ urgency }: { urgency: InboxRow["urgency"] }) {
  const urgent = urgency === "emergency";
  return <span className={`${base} ${urgent ? "bg-red-100 text-red-900" : "bg-stone-100 text-stone-800"}`}>{URGENCIES[urgency].label}</span>;
}

const ALERT_TEXT: Record<InboxRow["alert"], { text: string; tone: string }> = {
  sent: { text: "Email sent", tone: "text-green-800" },
  pending: { text: "Email queued", tone: "text-stone-700" },
  sending: { text: "Email sending", tone: "text-stone-700" },
  retrying: { text: "Email retrying", tone: "text-amber-800" },
  dead: { text: "Email FAILED", tone: "text-red-800 font-bold" },
  cancelled: { text: "No email needed", tone: "text-stone-700" },
  none: { text: "No email yet", tone: "text-amber-800" },
};

/** Tells the operator whether the alert email can be trusted to have gone out. */
export function AlertState({ state }: { state: InboxRow["alert"] }) {
  const { text, tone } = ALERT_TEXT[state];
  return <span className={`text-sm ${tone}`}>{text}</span>;
}

const CLIENT_STATUS: Record<string, string> = {
  prospect: "bg-stone-200 text-stone-800",
  active: "bg-green-100 text-green-900",
  paused: "bg-amber-100 text-amber-900",
  suspended: "bg-red-100 text-red-900",
  churned: "bg-stone-200 text-stone-700",
};
export function ClientStatusBadge({ status }: { status: string }) {
  return <span className={`${base} ${CLIENT_STATUS[status] ?? "bg-stone-200 text-stone-800"}`}>{status[0]!.toUpperCase() + status.slice(1)}</span>;
}

const ASSIGNMENT_STATUS: Record<string, { text: string; tone: string }> = {
  reserved: { text: "Not sent yet", tone: "bg-amber-100 text-amber-900" },
  notified: { text: "Sent", tone: "bg-green-100 text-green-900" },
  accepted: { text: "Accepted", tone: "bg-green-100 text-green-900" },
  disputed: { text: "Disputed", tone: "bg-red-100 text-red-900" },
  cancelled: { text: "Taken back", tone: "bg-stone-200 text-stone-800" },
  rejected: { text: "Rejected", tone: "bg-stone-200 text-stone-800" },
  expired: { text: "Expired", tone: "bg-stone-200 text-stone-800" },
  refunded: { text: "Refunded", tone: "bg-stone-200 text-stone-800" },
  delivery_failed: { text: "Delivery failed", tone: "bg-red-100 text-red-900" },
};
export function AssignmentStatusBadge({ status }: { status: string }) {
  const { text, tone } = ASSIGNMENT_STATUS[status] ?? { text: status, tone: "bg-stone-200 text-stone-800" };
  return <span className={`${base} ${tone}`}>{text}</span>;
}
