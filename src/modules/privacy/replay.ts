/**
 * Erasures made since the last backup must be re-applied after a restore (docs/04, docs/runbook.md): a backup still contains
 * people who have since been erased. The database cannot remember them (a restore rolls it back too), so the record lives in the
 * platform's LOGS, which are retained independently: every erasure logs `privacy: lead erased` with the lead id only.
 *
 * This reads newline-delimited JSON logs (the format the app writes) and returns the lead ids to erase again. It tolerates
 * everything else in the stream (other log lines, truncated or non-JSON lines, other services' output).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ERASURE_LOG_MESSAGE = "privacy: lead erased";

export function extractErasedLeadIds(logs: string): string[] {
  const ids = new Set<string>();
  for (const line of logs.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const entry = JSON.parse(trimmed) as { msg?: unknown; leadId?: unknown };
      if (entry.msg === ERASURE_LOG_MESSAGE && typeof entry.leadId === "string" && UUID.test(entry.leadId)) ids.add(entry.leadId.toLowerCase());
    } catch {
      /* not JSON: ignore */
    }
  }
  return [...ids];
}
