import { CLIENT_STATUS_LABELS } from "@/config/client-dashboard";
import { URGENCIES, type Urgency } from "@/config/lead-options";

const base = "inline-flex items-center rounded-full px-2.5 py-0.5 text-sm font-semibold";
const TONE: Record<string, string> = {
  reserved: "bg-brand-100 text-brand-900",
  notified: "bg-brand-100 text-brand-900",
  accepted: "bg-green-100 text-green-900",
  disputed: "bg-amber-100 text-amber-900",
  rejected: "bg-stone-200 text-stone-800",
  refunded: "bg-stone-200 text-stone-800",
  expired: "bg-stone-200 text-stone-800",
  cancelled: "bg-stone-200 text-stone-800",
};

/** Colour is never the only signal: the state is always written out. */
export function LeadStatusBadge({ status }: { status: keyof typeof CLIENT_STATUS_LABELS }) {
  return <span className={`${base} ${TONE[status] ?? "bg-stone-200 text-stone-800"}`}>{CLIENT_STATUS_LABELS[status]}</span>;
}

export function TimingBadge({ urgency }: { urgency: Urgency }) {
  return <span className={`${base} ${urgency === "emergency" ? "bg-red-100 text-red-900" : "bg-stone-100 text-stone-800"}`}>{URGENCIES[urgency].label}</span>;
}
