import { sql } from "kysely";
import type { Database } from "@/lib/db/client";
import type { PauseInput, RoutingPreferencesInput, WorkingWindowInput } from "./routing-schemas";

/** SQL for what a business asked for about routing: priority, weight, caps, working hours and pauses. Takes a `Database` (possibly a transaction). */

export interface RoutingPreferences {
  clientId: string;
  /** IANA name; the business's own clock for working hours, "today" and "this month". */
  timezone: string;
  priority: number;
  weight: number;
  dailyLeadCap: number | null;
  monthlyLeadCap: number | null;
}

export async function getRoutingPreferences(db: Database, clientId: string): Promise<RoutingPreferences | undefined> {
  const row = await db
    .selectFrom("clients")
    .select(["id", "timezone", "priority", "weight", "daily_lead_cap", "monthly_lead_cap"])
    .where("id", "=", clientId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row && { clientId: row.id, timezone: row.timezone, priority: row.priority, weight: row.weight, dailyLeadCap: row.daily_lead_cap, monthlyLeadCap: row.monthly_lead_cap };
}

export async function updateRoutingPreferences(db: Database, clientId: string, input: RoutingPreferencesInput): Promise<void> {
  await db
    .updateTable("clients")
    .set({ priority: input.priority, weight: input.weight, daily_lead_cap: input.dailyLeadCap, monthly_lead_cap: input.monthlyLeadCap })
    .where("id", "=", clientId)
    .execute();
}

export async function listWorkingHours(db: Database, clientId: string): Promise<WorkingWindowInput[]> {
  const { rows } = await sql<{ weekday: number; opens: string; closes: string }>`
    select weekday, to_char(opens, 'HH24:MI') as opens, to_char(closes, 'HH24:MI') as closes
      from client_working_hours where client_id = ${clientId} order by weekday, opens`.execute(db);
  return rows;
}

/** Replaces the whole weekly schedule. No windows = no restriction. */
export async function replaceWorkingHours(db: Database, clientId: string, windows: readonly WorkingWindowInput[]): Promise<void> {
  await db.deleteFrom("client_working_hours").where("client_id", "=", clientId).execute();
  for (const window of windows) {
    await sql`insert into client_working_hours (client_id, weekday, opens, closes) values (${clientId}, ${window.weekday}, ${window.opens}::time, ${window.closes}::time)`.execute(db);
  }
}

export interface PauseRow {
  id: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  /** "active" now, "upcoming", or "ended". */
  state: "active" | "upcoming" | "ended";
}

/** Pauses that have not ended, plus the most recent few that have (so a person can see what just finished). */
export async function listPauses(db: Database, clientId: string): Promise<PauseRow[]> {
  const { rows } = await sql<{ id: string; starts_at: Date; ends_at: Date; reason: string; state: PauseRow["state"] }>`
    select id, starts_at, ends_at, reason,
           case when ends_at <= now() then 'ended' when starts_at <= now() then 'active' else 'upcoming' end as state
      from client_pauses
     where client_id = ${clientId} and (ends_at > now() or ends_at > now() - interval '14 days')
     order by ends_at desc limit 20`.execute(db);
  return rows.map((row) => ({ id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, reason: row.reason, state: row.state }));
}

/** The pause as typed (in the business's own local time) is converted with the business's time zone, so "9 am" means 9 am THERE. */
export async function insertPause(db: Database, clientId: string, input: PauseInput, operatorId: string): Promise<string> {
  const { rows } = await sql<{ id: string }>`
    insert into client_pauses (client_id, starts_at, ends_at, reason, created_by)
    select c.id, (${input.from}::timestamp at time zone c.timezone), (${input.until}::timestamp at time zone c.timezone), ${input.reason}, ${operatorId}
      from clients c where c.id = ${clientId}
    returning id`.execute(db);
  return rows[0]!.id;
}

export async function getPause(db: Database, clientId: string, pauseId: string): Promise<{ id: string; startsAt: Date; endsAt: Date; reason: string } | undefined> {
  const row = await db.selectFrom("client_pauses").select(["id", "starts_at", "ends_at", "reason"]).where("id", "=", pauseId).where("client_id", "=", clientId).executeTakeFirst();
  return row && { id: row.id, startsAt: row.starts_at, endsAt: row.ends_at, reason: row.reason };
}

export async function deletePause(db: Database, clientId: string, pauseId: string): Promise<boolean> {
  const result = await db.deleteFrom("client_pauses").where("id", "=", pauseId).where("client_id", "=", clientId).executeTakeFirst();
  return result.numDeletedRows > 0n;
}

// ------------------------------------------------------------------------------------------------
// Delivery settings (stage 5): how the business wants to be told
// ------------------------------------------------------------------------------------------------

export interface DeliverySettings {
  clientId: string;
  mode: "manual" | "automatic";
  enabledAt: Date | null;
  email: boolean;
  sms: boolean;
  webhook: boolean;
  webhookUrl: string | null;
  /** The last four characters of the signing secret, or null if none was ever generated. The secret itself is never readable. */
  secretHint: string | null;
  failingSince: Date | null;
  contactEmail: string;
  contactPhone: string | null;
}

export async function getDeliverySettings(db: Database, clientId: string): Promise<DeliverySettings | undefined> {
  const row = await db
    .selectFrom("clients")
    .select(["id", "delivery_mode", "delivery_enabled_at", "notify_email", "notify_sms", "notify_webhook", "webhook_url", "webhook_secret_hint", "webhook_failing_since", "contact_email", "contact_phone_e164", "webhook_secret_enc"])
    .where("id", "=", clientId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  return row && {
    clientId: row.id, mode: row.delivery_mode, enabledAt: row.delivery_enabled_at, email: row.notify_email, sms: row.notify_sms, webhook: row.notify_webhook,
    webhookUrl: row.webhook_url, secretHint: row.webhook_secret_enc ? row.webhook_secret_hint : null, failingSince: row.webhook_failing_since, contactEmail: row.contact_email, contactPhone: row.contact_phone_e164,
  };
}

export async function hasWebhookSecret(db: Database, clientId: string): Promise<boolean> {
  const row = await db.selectFrom("clients").select("webhook_secret_enc").where("id", "=", clientId).executeTakeFirst();
  return Boolean(row?.webhook_secret_enc);
}

export async function updateDeliverySettings(db: Database, clientId: string, input: { mode: "manual" | "automatic"; email: boolean; sms: boolean; webhook: boolean; webhookUrl: string | null }, wasManual: boolean): Promise<void> {
  await sql`
    update clients set delivery_mode = ${input.mode}::delivery_mode,
           delivery_enabled_at = case when ${input.mode} = 'automatic' and ${wasManual} then now() else delivery_enabled_at end,
           notify_email = ${input.email}, notify_sms = ${input.sms}, notify_webhook = ${input.webhook}, webhook_url = ${input.webhookUrl}
     where id = ${clientId}`.execute(db);
}

export async function storeWebhookSecret(db: Database, clientId: string, encrypted: string, hint: string): Promise<void> {
  await sql`update clients set webhook_secret_enc = ${encrypted}, webhook_secret_hint = ${hint}, webhook_failing_since = null where id = ${clientId}`.execute(db);
}
