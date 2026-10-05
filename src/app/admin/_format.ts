const UK_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const UK_FULL = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  dateStyle: "medium",
  timeStyle: "medium",
});

/** "4 Oct, 21:30" in UK time, whatever timezone the server runs in. */
export const formatShort = (date: Date): string => UK_DATE_TIME.format(date);
/** "4 Oct 2026, 21:30:05" in UK time, for the timeline. */
export const formatFull = (date: Date): string => UK_FULL.format(date);

/** How long ago, in the units an operator thinks in: "just now", "12 min", "2 h 5 min", "1 d 3 h". */
export function waitingLabel(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days} d` : `${days} d ${hours % 24} h`;
}

/** Waiting longer than this is shown in red. Presentation only: the reminder policy lives in the worker. */
export const OVERDUE_AFTER_MINUTES = 30;
export const isOverdue = (from: Date, now: Date): boolean => now.getTime() - from.getTime() > OVERDUE_AFTER_MINUTES * 60_000;

/**
 * A mailto: link for an address that came from a consumer. Anything outside the characters an ordinary address
 * uses is percent-encoded, so a stray `?`, `&` or `%` can never become a header (`bcc=`, `body=`) in the operator's
 * mail client. Today's signup validation already refuses those characters; this keeps the inbox safe if another
 * path (stage 3's manual entry) ever lets one through.
 */
export function mailtoHref(email: string): string {
  return `mailto:${email.replace(/[^A-Za-z0-9._+\-'@]/g, (char) => encodeURIComponent(char))}`;
}
