import { sql } from "kysely";
import { CLIENT_STATUSES_THAT_CAN_SIGN_IN, type ClientUserRole } from "@/config/client-auth";
import type { Database } from "@/lib/db/client";

/** All SQL for client sign-in. Every time comparison uses the DATABASE's clock (one clock, not one per web instance). */

export interface ClientUserRecord {
  id: string;
  clientId: string;
  email: string;
  name: string;
  role: ClientUserRole;
  status: "invited" | "active" | "disabled";
  lastLoginAt: Date | null;
  createdAt: Date;
}

const USER_COLUMNS = ["id", "client_id", "email", "name", "role", "status", "last_login_at", "created_at"] as const;
const toUser = (row: { id: string; client_id: string; email: string; name: string; role: ClientUserRole; status: "invited" | "active" | "disabled"; last_login_at: Date | null; created_at: Date }): ClientUserRecord => ({
  id: row.id, clientId: row.client_id, email: row.email, name: row.name, role: row.role, status: row.status, lastLoginAt: row.last_login_at, createdAt: row.created_at,
});

const SIGN_IN_STATUSES = sql.join(CLIENT_STATUSES_THAT_CAN_SIGN_IN.map((status) => sql.lit(status)));

/** A person who may be sent a link: not disabled, and their business is in a state that can sign in. */
export async function findSignableUserByEmail(db: Database, email: string): Promise<{ id: string; name: string; email: string } | undefined> {
  const { rows } = await sql<{ id: string; name: string; email: string }>`
    select u.id, u.name, u.email from client_users u join clients c on c.id = u.client_id
     where u.email = ${email} and u.status <> 'disabled' and c.deleted_at is null and c.status::text in (${SIGN_IN_STATUSES})`.execute(db);
  return rows[0];
}

export async function countLinksInLastHour(db: Database, userId: string): Promise<number> {
  const { rows } = await sql<{ n: string }>`select count(*) as n from client_login_tokens where user_id = ${userId} and created_at > now() - interval '1 hour'`.execute(db);
  return Number(rows[0]?.n ?? 0);
}

export async function insertLoginToken(db: Database, input: { userId: string; hash: Buffer; ttlMinutes: number }): Promise<void> {
  await sql`insert into client_login_tokens (user_id, token_hash, expires_at) values (${input.userId}, ${input.hash}, now() + make_interval(mins => ${input.ttlMinutes}))`.execute(db);
}

/**
 * Spends a sign-in link. ONE statement decides: the row is changed only if it is unused and unexpired, so two simultaneous clicks
 * (or a click and a replay) cannot both succeed. Returns the person it was for, or undefined for unknown, used or expired.
 */
export async function consumeLoginToken(db: Database, hash: Buffer): Promise<string | undefined> {
  const { rows } = await sql<{ user_id: string }>`
    update client_login_tokens set consumed_at = now()
     where token_hash = ${hash} and consumed_at is null and expires_at > now()
     returning user_id`.execute(db);
  return rows[0]?.user_id;
}

/** The person behind a spent link, if they may still sign in. Locked so a concurrent disable cannot slip between check and session. */
export async function lockSignableUser(db: Database, userId: string): Promise<ClientUserRecord | undefined> {
  const { rows } = await sql<{ id: string; client_id: string; email: string; name: string; role: ClientUserRole; status: "invited" | "active" | "disabled"; last_login_at: Date | null; created_at: Date }>`
    select u.id, u.client_id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at
      from client_users u join clients c on c.id = u.client_id
     where u.id = ${userId} and u.status <> 'disabled' and c.deleted_at is null and c.status::text in (${SIGN_IN_STATUSES})
       for update of u`.execute(db);
  return rows[0] && toUser(rows[0]);
}

export async function insertSession(db: Database, input: { userId: string; hash: Buffer; absoluteDays: number }): Promise<Date> {
  const { rows } = await sql<{ expires_at: Date }>`
    insert into client_sessions (user_id, token_hash, expires_at) values (${input.userId}, ${input.hash}, now() + make_interval(days => ${input.absoluteDays}))
    returning expires_at`.execute(db);
  return rows[0]!.expires_at;
}

export async function markSignedIn(db: Database, userId: string): Promise<void> {
  await sql`update client_users set last_login_at = now(), status = case when status = 'invited' then 'active'::client_user_status else status end where id = ${userId}`.execute(db);
}

export interface SessionRecord {
  sessionId: string;
  userId: string;
  clientId: string;
  clientName: string;
  name: string;
  email: string;
  role: ClientUserRole;
  /** Whole minutes since the session was last recorded as active. */
  minutesSinceSeen: number;
}

/**
 * The session behind a cookie value, or nothing. Every condition is checked HERE, on every request: not revoked, not past its
 * absolute end, not idle too long, the person not disabled, the business still allowed to sign in. Nothing is trusted from the cookie.
 */
export async function findLiveSession(db: Database, hash: Buffer, idleHours: number): Promise<SessionRecord | undefined> {
  const { rows } = await sql<{ session_id: string; user_id: string; client_id: string; client_name: string; name: string; email: string; role: ClientUserRole; minutes: number }>`
    select s.id as session_id, u.id as user_id, u.client_id, c.name as client_name, u.name, u.email, u.role,
           floor(extract(epoch from (now() - s.last_seen_at)) / 60)::int as minutes
      from client_sessions s
      join client_users u on u.id = s.user_id
      join clients c on c.id = u.client_id
     where s.token_hash = ${hash}
       and s.revoked_at is null
       and s.expires_at > now()
       and s.last_seen_at > now() - make_interval(hours => ${idleHours})
       and u.status <> 'disabled'
       and c.deleted_at is null and c.status::text in (${SIGN_IN_STATUSES})`.execute(db);
  const row = rows[0];
  return row && { sessionId: row.session_id, userId: row.user_id, clientId: row.client_id, clientName: row.client_name, name: row.name, email: row.email, role: row.role, minutesSinceSeen: row.minutes };
}

export async function touchSession(db: Database, sessionId: string): Promise<void> {
  await sql`update client_sessions set last_seen_at = now() where id = ${sessionId} and revoked_at is null`.execute(db);
}

export async function revokeSessionByHash(db: Database, hash: Buffer): Promise<void> {
  await sql`update client_sessions set revoked_at = now() where token_hash = ${hash} and revoked_at is null`.execute(db);
}

export async function revokeSessionsForUser(db: Database, userId: string): Promise<number> {
  const { numAffectedRows } = await sql`update client_sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`.execute(db);
  return Number(numAffectedRows ?? 0);
}

// ---- Staff side: who may sign in for a business ----

export async function listUsers(db: Database, clientId: string): Promise<ClientUserRecord[]> {
  const rows = await db.selectFrom("client_users").select(USER_COLUMNS).where("client_id", "=", clientId).orderBy("created_at").execute();
  return rows.map(toUser);
}

export async function getUser(db: Database, userId: string): Promise<ClientUserRecord | undefined> {
  const row = await db.selectFrom("client_users").select(USER_COLUMNS).where("id", "=", userId).executeTakeFirst();
  return row && toUser(row);
}

export async function insertUser(db: Database, input: { clientId: string; email: string; name: string; role: ClientUserRole; invitedBy: string }): Promise<string> {
  const row = await db.insertInto("client_users").values({ client_id: input.clientId, email: input.email, name: input.name, role: input.role, invited_by: input.invitedBy }).returning("id").executeTakeFirstOrThrow();
  return row.id;
}

export async function setUserStatus(db: Database, userId: string, status: "disabled" | "invited" | "active"): Promise<void> {
  await sql`update client_users set status = ${status}::client_user_status, disabled_at = ${status === "disabled" ? sql`now()` : null} where id = ${userId}`.execute(db);
}

export async function setUserRole(db: Database, userId: string, role: ClientUserRole): Promise<void> {
  await db.updateTable("client_users").set({ role }).where("id", "=", userId).execute();
}

/** Housekeeping: spent and expired links and ended sessions older than a week carry no value. */
export async function deleteStaleCredentials(db: Database): Promise<{ links: number; sessions: number }> {
  const links = await sql`delete from client_login_tokens where expires_at < now() - interval '7 days'`.execute(db);
  const sessions = await sql`delete from client_sessions where (expires_at < now() - interval '7 days') or (revoked_at is not null and revoked_at < now() - interval '7 days')`.execute(db);
  return { links: Number(links.numAffectedRows ?? 0), sessions: Number(sessions.numAffectedRows ?? 0) };
}
