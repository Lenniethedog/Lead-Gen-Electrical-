import { sql } from "kysely";
import { FRAUD_LIMITS } from "@/config/fraud";
import type { Database } from "@/lib/db/client";
import { signal, type FraudSignal } from "./score";

export interface HistoryInput {
  ip: string | null;
  phoneE164: string;
  emailNormalised: string;
}

interface HistoryCounts {
  ip_recent: string;
  phone_other_identity: string;
  email_other_identity: string;
}

/**
 * Signals derived from recent submissions. Runs inside the lead transaction (after the identity
 * lock), so concurrent submissions from the same person see each other.
 *
 *  - IP velocity: how many leads this address submitted in the last hour. Shared addresses
 *    (offices, mobile carrier NAT) exist, so the weights are moderate and never reject alone.
 *  - Identity reuse: the same phone with a DIFFERENT email (or vice versa) in the last week is a
 *    classic sign of someone cycling details. The same phone AND email again is handled as a
 *    duplicate by the lead service, not as fraud.
 */
export async function collectHistorySignals(db: Database, input: HistoryInput): Promise<FraudSignal[]> {
  const { windowMinutes, elevatedAt, highAt } = FRAUD_LIMITS.ipVelocity;
  const reuseInterval = `${FRAUD_LIMITS.identityReuseDays} days`;

  const { rows } = await sql<HistoryCounts>`
    select
      (select count(*) from lead_contacts
         where ${input.ip}::inet is not null
           and ip = ${input.ip}::inet
           and created_at > now() - make_interval(mins => ${windowMinutes})) as ip_recent,
      (select count(*) from lead_contacts
         where phone_e164 = ${input.phoneE164}
           and email_normalised <> ${input.emailNormalised}
           and created_at > now() - ${reuseInterval}::interval) as phone_other_identity,
      (select count(*) from lead_contacts
         where email_normalised = ${input.emailNormalised}
           and phone_e164 <> ${input.phoneE164}
           and created_at > now() - ${reuseInterval}::interval) as email_other_identity
  `.execute(db);

  const counts = rows[0];
  const signals: FraudSignal[] = [];
  if (!counts) return signals;

  // The current submission is not stored yet, so these count only PREVIOUS leads.
  const ipRecent = Number(counts.ip_recent);
  if (ipRecent >= highAt) signals.push(signal("ip_velocity_high", { leadsInWindow: ipRecent }));
  else if (ipRecent >= elevatedAt) signals.push(signal("ip_velocity_elevated", { leadsInWindow: ipRecent }));

  if (Number(counts.phone_other_identity) > 0) signals.push(signal("phone_reused_with_other_identity"));
  if (Number(counts.email_other_identity) > 0) signals.push(signal("email_reused_with_other_identity"));
  return signals;
}
