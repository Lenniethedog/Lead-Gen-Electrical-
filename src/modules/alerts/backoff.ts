/**
 * Retry timing for operator alerts (docs/03, "Notification lifecycle and retry policy").
 *
 * The value of an alert decays within minutes, so the early retries are quick and the tail is about
 * eventual delivery rather than speed: 5 s, 15 s, 45 s, 2 min, 5 min, 15 min, 30 min, then dead.
 * Each delay is jittered by +-20% so a provider outage does not turn into a synchronized retry wave.
 */
const BASE_DELAYS_SECONDS = [5, 15, 45, 120, 300, 900, 1800] as const;

/** Attempts before an alert is declared dead (one try plus one per delay above). Mirrors the column default. */
export const MAX_ALERT_ATTEMPTS = BASE_DELAYS_SECONDS.length + 1;

const JITTER = 0.2;

/** Milliseconds to wait after attempt number `failedAttemptNo` (1-based) failed. */
export function retryDelayMs(failedAttemptNo: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(Math.trunc(failedAttemptNo), 1), BASE_DELAYS_SECONDS.length) - 1;
  const base = BASE_DELAYS_SECONDS[index]! * 1000;
  return Math.round(base * (1 + (random() * 2 - 1) * JITTER));
}
