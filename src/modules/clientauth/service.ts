import type { Logger } from "pino";
import * as z from "zod";
import { CLIENT_AUTH, CLIENT_USER_ROLES, type ClientUserRole } from "@/config/client-auth";
import type { Database } from "@/lib/db/client";
import type { EmailSender } from "@/modules/alerts";
import { writeAudit } from "@/modules/audit";
import type { Operator } from "@/modules/inbox";
import { buildSignInMessage } from "./message";
import {
  consumeLoginToken,
  countLinksInLastHour,
  deleteStaleCredentials,
  findLiveSession,
  findSignableUserByEmail,
  getUser,
  insertLoginToken,
  insertSession,
  insertUser,
  listUsers,
  lockSignableUser,
  markSignedIn,
  revokeSessionByHash,
  revokeSessionsForUser,
  setUserRole,
  setUserStatus,
  touchSession,
  type ClientUserRecord,
} from "./repo";
import { hashSecret, looksLikeSecret, newSecret } from "./tokens";

export interface ClientAuthServiceDeps {
  db: Database;
  logger: Logger;
  sender: EmailSender;
  /** Where the sign-in page lives, e.g. https://www.example.co.uk (no trailing slash needed). */
  appUrl: string;
  brandName: string;
}

/** Who is signed in. Handed to every dashboard function: it, and nothing the browser sends, decides which business's data is touched. */
export interface ClientSession {
  sessionId: string;
  userId: string;
  clientId: string;
  clientName: string;
  name: string;
  email: string;
  role: ClientUserRole;
}

export type StaffFailure = "not_found" | "invalid_input" | "email_taken" | "already_in_state";
export type StaffResult<T = object> = ({ ok: true } & T) | { ok: false; code: StaffFailure };

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));
const inviteSchema = z.object({ email: emailSchema, name: z.string().trim().min(1).max(120), role: z.enum(CLIENT_USER_ROLES) });

export function createClientAuthService(deps: ClientAuthServiceDeps) {
  const { db, logger } = deps;
  const signInUrl = (token: string) => `${deps.appUrl.replace(/\/+$/, "")}/dashboard/signin?token=${encodeURIComponent(token)}`;
  /** Sends still in flight, so a test (or a clean shutdown) can wait for them. */
  const sending = new Set<Promise<void>>();

  async function sendLink(user: { id: string; name: string; email: string }, requestId: string): Promise<"sent" | "limited"> {
    if ((await countLinksInLastHour(db, user.id)) >= CLIENT_AUTH.maxLinksPerHour) return "limited";
    const secret = newSecret();
    await insertLoginToken(db, { userId: user.id, hash: secret.hash, ttlMinutes: CLIENT_AUTH.linkTtlMinutes });
    const message = buildSignInMessage({ name: user.name, brandName: deps.brandName, link: signInUrl(secret.raw) });
    // Not awaited: a known address would otherwise take a provider round-trip longer than an unknown one, which tells a stranger who has an account.
    const task = deps.sender
      .send({ to: [user.email], subject: message.subject, text: message.text, idempotencyKey: `signin-${user.id}-${secret.hash.toString("hex").slice(0, 16)}` }, { signal: AbortSignal.timeout(10_000) })
      .then((result) => {
        if (result.outcome !== "accepted") logger.error({ userId: user.id, requestId, outcome: result.outcome, errorCode: result.errorCode }, "sign-in link email was not sent");
      })
      .catch((error: unknown) => logger.error({ userId: user.id, requestId, err: error instanceof Error ? error.name : "unknown" }, "sign-in link email failed"))
      .finally(() => void sending.delete(task));
    sending.add(task);
    return "sent";
  }

  return {
    /**
     * "Email me a sign-in link." The caller says the same thing whatever happens here (no account enumeration): an unknown address,
     * a disabled person, a suspended business and a rate-limited person all look identical from outside. Nothing is returned.
     */
    async requestLink(input: { email: string; requestId: string }): Promise<void> {
      const parsed = emailSchema.safeParse(input.email);
      if (!parsed.success) return;
      const user = await findSignableUserByEmail(db, parsed.data);
      if (!user) return;
      const outcome = await sendLink(user, input.requestId);
      if (outcome === "limited") logger.warn({ userId: user.id, requestId: input.requestId }, "sign-in links limited for this person");
    },

    /**
     * Spends a sign-in link and starts a session. Anything wrong with the link (unknown, used, expired, person disabled) gives the same
     * `invalid` and the link is spent in every case. A NEW session secret is made here: nothing from before sign-in is reused.
     */
    async redeem(input: { token: unknown }): Promise<{ ok: true; sessionToken: string; expiresAt: Date; clientId: string } | { ok: false; code: "invalid" }> {
      if (!looksLikeSecret(input.token)) return { ok: false, code: "invalid" };
      const hash = hashSecret(input.token);
      return db.transaction().execute(async (trx) => {
        const userId = await consumeLoginToken(trx, hash);
        if (!userId) return { ok: false, code: "invalid" } as const;
        const user = await lockSignableUser(trx, userId);
        if (!user) return { ok: false, code: "invalid" } as const;
        const session = newSecret();
        const expiresAt = await insertSession(trx, { userId: user.id, hash: session.hash, absoluteDays: CLIENT_AUTH.sessionAbsoluteDays });
        await markSignedIn(trx, user.id);
        return { ok: true, sessionToken: session.raw, expiresAt, clientId: user.clientId } as const;
      });
    },

    /** The signed-in person for a cookie value, or undefined. Checked against the database every time; recorded as active at most every few minutes. */
    async resolve(sessionToken: unknown): Promise<ClientSession | undefined> {
      if (!looksLikeSecret(sessionToken)) return undefined;
      const found = await findLiveSession(db, hashSecret(sessionToken), CLIENT_AUTH.sessionIdleHours);
      if (!found) return undefined;
      if (found.minutesSinceSeen >= CLIENT_AUTH.touchEveryMinutes) await touchSession(db, found.sessionId);
      return { sessionId: found.sessionId, userId: found.userId, clientId: found.clientId, clientName: found.clientName, name: found.name, email: found.email, role: found.role };
    },

    async signOut(sessionToken: unknown): Promise<void> {
      if (looksLikeSecret(sessionToken)) await revokeSessionByHash(db, hashSecret(sessionToken));
    },

    // ---- Staff: who may sign in for a business (audited; the dashboard cannot reach these) ----

    users(clientId: string): Promise<ClientUserRecord[]> {
      return listUsers(db, clientId);
    },

    find(userId: string): Promise<ClientUserRecord | undefined> {
      return getUser(db, userId);
    },

    async invite(input: { operator: Operator; clientId: string; email: string; name: string; role: ClientUserRole; requestId: string }): Promise<StaffResult<{ userId: string }>> {
      const parsed = inviteSchema.safeParse({ email: input.email, name: input.name, role: input.role });
      if (!parsed.success) return { ok: false, code: "invalid_input" };
      const client = await db.selectFrom("clients").select("id").where("id", "=", input.clientId).where("deleted_at", "is", null).executeTakeFirst();
      if (!client) return { ok: false, code: "not_found" };
      try {
        const userId = await db.transaction().execute(async (trx) => {
          const id = await insertUser(trx, { clientId: input.clientId, email: parsed.data.email, name: parsed.data.name, role: parsed.data.role, invitedBy: input.operator.id });
          await writeAudit(trx, { actorId: input.operator.id, action: "client_user.invited", entityType: "client_user", entityId: id, after: { client_id: input.clientId, role: parsed.data.role }, requestId: input.requestId });
          return id;
        });
        await sendLink({ id: userId, name: parsed.data.name, email: parsed.data.email }, input.requestId);
        return { ok: true, userId };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return { ok: false, code: "email_taken" };
        throw error;
      }
    },

    /** Sends a fresh link to someone already invited (the first one expired, or went to spam). */
    async resend(input: { operator: Operator; userId: string; requestId: string }): Promise<StaffResult> {
      const user = await getUser(db, input.userId);
      if (!user) return { ok: false, code: "not_found" };
      const signable = await findSignableUserByEmail(db, user.email);
      if (!signable) return { ok: false, code: "already_in_state" };
      await sendLink(signable, input.requestId);
      await writeAudit(db, { actorId: input.operator.id, action: "client_user.link_resent", entityType: "client_user", entityId: user.id, requestId: input.requestId });
      return { ok: true };
    },

    /** Disables or re-enables a person. Disabling ends every session they have, in the same transaction. */
    async setStatus(input: { operator: Operator; userId: string; disabled: boolean; requestId: string }): Promise<StaffResult> {
      return db.transaction().execute(async (trx): Promise<StaffResult> => {
        const user = await getUser(trx, input.userId);
        if (!user) return { ok: false, code: "not_found" };
        if (input.disabled === (user.status === "disabled")) return { ok: false, code: "already_in_state" };
        await setUserStatus(trx, user.id, input.disabled ? "disabled" : user.lastLoginAt ? "active" : "invited");
        const ended = input.disabled ? await revokeSessionsForUser(trx, user.id) : 0;
        await writeAudit(trx, { actorId: input.operator.id, action: input.disabled ? "client_user.disabled" : "client_user.enabled", entityType: "client_user", entityId: user.id, before: { status: user.status }, after: { sessions_ended: ended }, requestId: input.requestId });
        return { ok: true };
      });
    },

    async setRole(input: { operator: Operator; userId: string; role: ClientUserRole; requestId: string }): Promise<StaffResult> {
      if (!(CLIENT_USER_ROLES as readonly string[]).includes(input.role)) return { ok: false, code: "invalid_input" };
      return db.transaction().execute(async (trx): Promise<StaffResult> => {
        const user = await getUser(trx, input.userId);
        if (!user) return { ok: false, code: "not_found" };
        if (user.role === input.role) return { ok: false, code: "already_in_state" };
        await setUserRole(trx, user.id, input.role);
        await writeAudit(trx, { actorId: input.operator.id, action: "client_user.role_changed", entityType: "client_user", entityId: user.id, before: { role: user.role }, after: { role: input.role }, requestId: input.requestId });
        return { ok: true };
      });
    },

    /** Called by the worker now and then. */
    cleanUp(): Promise<{ links: number; sessions: number }> {
      return deleteStaleCredentials(db);
    },

    /** Waits for sign-in emails still being sent (tests; shutdown). */
    async idle(): Promise<void> {
      while (sending.size > 0) await Promise.allSettled([...sending]);
    },
  };
}

export type ClientAuthService = ReturnType<typeof createClientAuthService>;
