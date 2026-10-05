import { createHash } from "node:crypto";
import { sql } from "kysely";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIENT_AUTH } from "../../src/config/client-auth";
import { createClientAuthService } from "../../src/modules/clientauth";
import type { EmailMessage, EmailSender, SendResult } from "../../src/modules/alerts";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildStage3 } from "../helpers/stage3";

/**
 * Signing in as a business (stage 6, D43). The properties that matter: a link works ONCE even when clicked twice at the same instant,
 * expires, never reveals whether an address has an account, and a session ends the moment the person or their business may no longer
 * sign in. Nothing is trusted from the cookie.
 */
let t: TestDatabase;
let s: ReturnType<typeof buildStage3>;
let ops: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
let clientId: string;

class Outbox implements EmailSender {
  sent: EmailMessage[] = [];
  result: SendResult = { outcome: "accepted" };
  async send(message: EmailMessage): Promise<SendResult> {
    this.sent.push(message);
    return this.result;
  }
  /** The token in the most recent email to this address. */
  linkFor(address: string): string {
    const mail = [...this.sent].reverse().find((m) => m.to.includes(address));
    const match = mail?.text.match(/token=([A-Za-z0-9_-]{43})/);
    if (!match) throw new Error(`no sign-in link was sent to ${address}`);
    return match[1]!;
  }
  to(address: string): number {
    return this.sent.filter((m) => m.to.includes(address)).length;
  }
}

let outbox: Outbox;
let auth: ReturnType<typeof createClientAuthService>;
/** SHA-256 computed here, NOT with the code under test, so a broken hash function cannot agree with itself. */
const sha256 = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const email = () => `person-${crypto.randomUUID().slice(0, 8)}@roofer.example`;

beforeAll(async () => {
  t = await createTestDatabase();
  s = buildStage3(t);
  ops = await s.operator("auth@example.com");
  clientId = await s.activeClient(ops, { name: "Sign In Roofing" });
  outbox = new Outbox();
  auth = createClientAuthService({ db: t.db, logger: pino({ level: "silent" }), sender: outbox, appUrl: "https://www.example.co.uk/", brandName: "Test Brand" });
});
afterAll(async () => {
  await t.destroy();
});

async function invited(role: "owner" | "manager" | "agent" = "agent"): Promise<{ userId: string; address: string }> {
  const address = email();
  const result = await auth.invite({ operator: ops, clientId, email: address, name: "Sam Smith", role, requestId: s.rid() });
  if (!result.ok) throw new Error(result.code);
  await auth.idle();
  return { userId: result.userId, address };
}

async function signedIn(role: "owner" | "manager" | "agent" = "agent") {
  const person = await invited(role);
  const redeemed = await auth.redeem({ token: outbox.linkFor(person.address) });
  if (!redeemed.ok) throw new Error("could not sign in");
  return { ...person, sessionToken: redeemed.sessionToken };
}

describe("asking for a sign-in link", () => {
  it("emails a link that points at the sign-in page, with a 43 character secret, and says nothing about the person", async () => {
    const person = await invited();
    const mail = outbox.sent.filter((m) => m.to.includes(person.address)).at(-1)!;
    expect(mail.text).toMatch(/https:\/\/www\.example\.co\.uk\/dashboard\/signin\?token=[A-Za-z0-9_-]{43}\b/);
    expect(mail.subject).toContain("Test Brand");
    expect(mail.text).toContain(`${CLIENT_AUTH.linkTtlMinutes} minutes`);
  });

  it("stores only a hash of the link: the secret is nowhere in the database", async () => {
    const person = await invited();
    const token = outbox.linkFor(person.address);
    const rows = await sql<{ token_hash: Buffer }>`select token_hash from client_login_tokens where user_id = ${person.userId}`.execute(t.admin);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.token_hash).toHaveLength(32);
    expect(rows.rows[0]!.token_hash.equals(sha256(token))).toBe(true);
    expect(rows.rows[0]!.token_hash.toString("utf8")).not.toContain(token);
  });

  it("sends nothing for an unknown address, a disabled person or a bad address, and returns the same nothing every time (no account enumeration)", async () => {
    const known = await invited();
    const disabled = await invited();
    await auth.setStatus({ operator: ops, userId: disabled.userId, disabled: true, requestId: s.rid() });
    const before = outbox.sent.length;
    const results = await Promise.all([
      auth.requestLink({ email: known.address, requestId: s.rid() }),
      auth.requestLink({ email: email(), requestId: s.rid() }),
      auth.requestLink({ email: disabled.address, requestId: s.rid() }),
      auth.requestLink({ email: "not an address", requestId: s.rid() }),
    ]);
    await auth.idle();
    expect(results).toEqual([undefined, undefined, undefined, undefined]);
    expect(outbox.sent.length - before).toBe(1); // only the known, enabled person
  });

  it("matches an address whatever its case or spacing", async () => {
    const person = await invited();
    const before = outbox.to(person.address);
    await auth.requestLink({ email: `  ${person.address.toUpperCase()} `, requestId: s.rid() });
    await auth.idle();
    expect(outbox.to(person.address)).toBe(before + 1);
  });

  it(`sends at most ${CLIENT_AUTH.maxLinksPerHour} links an hour to one person, counted in the database`, async () => {
    const person = await invited(); // 1 (the invitation)
    for (let i = 0; i < 12; i += 1) await auth.requestLink({ email: person.address, requestId: s.rid() });
    await auth.idle();
    expect(outbox.to(person.address)).toBe(CLIENT_AUTH.maxLinksPerHour);
  });

  it("does not wait for the email provider, and a failing provider does not break the request", async () => {
    const person = await invited();
    outbox.result = { outcome: "retryable_failure", errorCode: "http_503" };
    await expect(auth.requestLink({ email: person.address, requestId: s.rid() })).resolves.toBeUndefined();
    await auth.idle();
    outbox.result = { outcome: "accepted" };
  });

  it("does not send to a business that is suspended", async () => {
    const other = await s.activeClient(ops);
    const result = await auth.invite({ operator: ops, clientId: other, email: email(), name: "Pat", role: "agent", requestId: s.rid() });
    if (!result.ok) throw new Error(result.code);
    await auth.idle();
    const user = await t.admin.selectFrom("client_users").select("email").where("id", "=", result.userId).executeTakeFirstOrThrow();
    await s.clients.setStatus({ operator: ops, clientId: other, status: "suspended", reason: "non_payment", requestId: s.rid() });
    const before = outbox.sent.length;
    await auth.requestLink({ email: user.email, requestId: s.rid() });
    await auth.idle();
    expect(outbox.sent.length).toBe(before);
  });
});

describe("using a link", () => {
  it("signs the person in, makes them active, and records when", async () => {
    const person = await invited();
    const result = await auth.redeem({ token: outbox.linkFor(person.address) });
    expect(result.ok).toBe(true);
    const row = await t.admin.selectFrom("client_users").select(["status", "last_login_at"]).where("id", "=", person.userId).executeTakeFirstOrThrow();
    expect(row.status).toBe("active");
    expect(row.last_login_at).not.toBeNull();
    if (!result.ok) return;
    expect(result.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await auth.resolve(result.sessionToken)).toMatchObject({ userId: person.userId, clientId, role: "agent", clientName: "Sign In Roofing" });
  });

  it("works ONCE: a second use of the same link is refused", async () => {
    const person = await invited();
    const token = outbox.linkFor(person.address);
    expect((await auth.redeem({ token })).ok).toBe(true);
    expect(await auth.redeem({ token })).toEqual({ ok: false, code: "invalid" });
  });

  it("RACE: twenty simultaneous clicks on one link produce exactly one session", async () => {
    const person = await invited();
    const token = outbox.linkFor(person.address);
    const results = await Promise.all(Array.from({ length: 20 }, () => auth.redeem({ token })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const sessions = await sql<{ n: string }>`select count(*) as n from client_sessions where user_id = ${person.userId}`.execute(t.admin);
    expect(Number(sessions.rows[0]!.n)).toBe(1);
  });

  it("is refused once it has expired", async () => {
    const person = await invited();
    const token = outbox.linkFor(person.address);
    await sql`update client_login_tokens set created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour' where user_id = ${person.userId}`.execute(t.admin);
    expect(await auth.redeem({ token })).toEqual({ ok: false, code: "invalid" });
  });

  it("is refused for anything that is not one of ours, without touching the database", async () => {
    // A database that explodes if it is used at all: malformed input must be turned away before any query.
    const untouchable = new Proxy({}, { get: () => { throw new Error("the database was used"); } }) as never;
    const strict = createClientAuthService({ db: untouchable, logger: pino({ level: "silent" }), sender: outbox, appUrl: "https://x.example", brandName: "B" });
    for (const token of [undefined, null, "", "abc", "x".repeat(43) + "!", 12345, { token: "x" }, "A".repeat(44), "A".repeat(42)]) {
      expect(await strict.redeem({ token })).toEqual({ ok: false, code: "invalid" });
      expect(await strict.resolve(token)).toBeUndefined();
    }
    for (const token of [undefined, null, "", "abc", "x".repeat(43) + "!", 12345, { token: "x" }, "A".repeat(44)]) {
      expect(await auth.redeem({ token })).toEqual({ ok: false, code: "invalid" });
    }
    expect(await auth.redeem({ token: "A".repeat(43) })).toEqual({ ok: false, code: "invalid" }); // well-formed but unknown
  });

  it("is useless if the person was disabled after the link was sent (and the link is spent)", async () => {
    const person = await invited();
    const token = outbox.linkFor(person.address);
    await auth.setStatus({ operator: ops, userId: person.userId, disabled: true, requestId: s.rid() });
    expect(await auth.redeem({ token })).toEqual({ ok: false, code: "invalid" });
    await auth.setStatus({ operator: ops, userId: person.userId, disabled: false, requestId: s.rid() });
    expect(await auth.redeem({ token })).toEqual({ ok: false, code: "invalid" });
  });

  it("every sign-in gets its own new session secret", async () => {
    const person = await invited();
    const first = await auth.redeem({ token: outbox.linkFor(person.address) });
    await auth.requestLink({ email: person.address, requestId: s.rid() });
    await auth.idle();
    const second = await auth.redeem({ token: outbox.linkFor(person.address) });
    if (!first.ok || !second.ok) throw new Error("sign-in failed");
    expect(first.sessionToken).not.toBe(second.sessionToken);
    expect(await auth.resolve(first.sessionToken)).toBeDefined();
    expect(await auth.resolve(second.sessionToken)).toBeDefined();
  });
});

describe("a session", () => {
  it("is stored only as a hash", async () => {
    const me = await signedIn();
    const rows = await sql<{ token_hash: Buffer }>`select token_hash from client_sessions where user_id = ${me.userId}`.execute(t.admin);
    expect(rows.rows[0]!.token_hash.equals(sha256(me.sessionToken))).toBe(true);
    expect(rows.rows[0]!.token_hash.toString("utf8")).not.toContain(me.sessionToken);
  });

  it("is refused for a made-up, malformed or empty cookie", async () => {
    for (const cookie of [undefined, "", "nope", "A".repeat(43), "A".repeat(100)]) expect(await auth.resolve(cookie)).toBeUndefined();
  });

  it("ends when the person signs out", async () => {
    const me = await signedIn();
    await auth.signOut(me.sessionToken);
    expect(await auth.resolve(me.sessionToken)).toBeUndefined();
  });

  it(`ends after ${CLIENT_AUTH.sessionIdleHours} hours without a request`, async () => {
    const me = await signedIn();
    await sql`update client_sessions set last_seen_at = now() - interval '13 hours' where user_id = ${me.userId}`.execute(t.admin);
    expect(await auth.resolve(me.sessionToken)).toBeUndefined();
  });

  it("is still good just inside the idle limit, and being used keeps it alive", async () => {
    const me = await signedIn();
    await sql`update client_sessions set last_seen_at = now() - interval '11 hours' where user_id = ${me.userId}`.execute(t.admin);
    expect(await auth.resolve(me.sessionToken)).toBeDefined();
    const row = await sql<{ fresh: boolean }>`select last_seen_at > now() - interval '1 minute' as fresh from client_sessions where user_id = ${me.userId}`.execute(t.admin);
    expect(row.rows[0]!.fresh).toBe(true);
  });

  it(`ends ${CLIENT_AUTH.sessionAbsoluteDays} days after sign-in however active the person is`, async () => {
    const me = await signedIn();
    await sql`update client_sessions set created_at = now() - interval '15 days', expires_at = now() - interval '1 day' where user_id = ${me.userId}`.execute(t.admin);
    expect(await auth.resolve(me.sessionToken)).toBeUndefined();
  });

  it("ends at once, on every browser, when staff disable the person", async () => {
    const me = await signedIn();
    const other = await auth.redeem({ token: (await (async () => { await auth.requestLink({ email: me.address, requestId: s.rid() }); await auth.idle(); return outbox.linkFor(me.address); })()) });
    if (!other.ok) throw new Error("second browser failed");
    await auth.setStatus({ operator: ops, userId: me.userId, disabled: true, requestId: s.rid() });
    expect(await auth.resolve(me.sessionToken)).toBeUndefined();
    expect(await auth.resolve(other.sessionToken)).toBeUndefined();
    const revoked = await sql<{ n: string }>`select count(*) as n from client_sessions where user_id = ${me.userId} and revoked_at is not null`.execute(t.admin);
    expect(Number(revoked.rows[0]!.n)).toBe(2);
  });

  it("is refused even if nothing revoked it, once the person is disabled or the business is no longer allowed in (checked on every request)", async () => {
    const me = await signedIn();
    await t.admin.updateTable("client_users").set({ status: "disabled", disabled_at: new Date() }).where("id", "=", me.userId).execute();
    expect(await auth.resolve(me.sessionToken)).toBeUndefined();

    const them = await signedIn();
    await s.clients.setStatus({ operator: ops, clientId, status: "suspended", reason: "non_payment", requestId: s.rid() });
    expect(await auth.resolve(them.sessionToken)).toBeUndefined();
    await s.clients.setStatus({ operator: ops, clientId, status: "active", requestId: s.rid() });
    expect(await auth.resolve(them.sessionToken)).toBeDefined();
  });

  it("still works for a business that has only paused leads", async () => {
    const me = await signedIn();
    await s.clients.setStatus({ operator: ops, clientId, status: "paused", reason: "paused_by_client", requestId: s.rid() });
    expect(await auth.resolve(me.sessionToken)).toBeDefined();
    await s.clients.setStatus({ operator: ops, clientId, status: "active", requestId: s.rid() });
  });
});

describe("staff managing who can sign in", () => {
  it("invites once per address across ALL businesses, and says so", async () => {
    const address = email();
    expect((await auth.invite({ operator: ops, clientId, email: address, name: "A", role: "agent", requestId: s.rid() })).ok).toBe(true);
    const otherClient = await s.activeClient(ops);
    expect(await auth.invite({ operator: ops, clientId: otherClient, email: address.toUpperCase(), name: "A", role: "agent", requestId: s.rid() })).toEqual({ ok: false, code: "email_taken" });
    expect(await auth.invite({ operator: ops, clientId, email: "nope", name: "A", role: "agent", requestId: s.rid() })).toEqual({ ok: false, code: "invalid_input" });
    expect(await auth.invite({ operator: ops, clientId, email: email(), name: "  ", role: "agent", requestId: s.rid() })).toEqual({ ok: false, code: "invalid_input" });
    expect(await auth.invite({ operator: ops, clientId: "00000000-0000-4000-8000-000000000000", email: email(), name: "A", role: "agent", requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
  });

  it("audits who invited, disabled, re-enabled and changed the role of whom, with no email address in the trail", async () => {
    const person = await invited();
    await auth.setRole({ operator: ops, userId: person.userId, role: "manager", requestId: s.rid() });
    await auth.setStatus({ operator: ops, userId: person.userId, disabled: true, requestId: s.rid() });
    await auth.setStatus({ operator: ops, userId: person.userId, disabled: false, requestId: s.rid() });
    const entries = await t.admin.selectFrom("audit_logs").select(["action", "actor_id", "before", "after"]).where("entity_id", "=", person.userId).orderBy("id").execute();
    expect(entries.map((e) => e.action)).toEqual(["client_user.invited", "client_user.role_changed", "client_user.disabled", "client_user.enabled"]);
    expect(entries.every((e) => e.actor_id === ops.id)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(person.address);
  });

  it("will not repeat a change that has already happened", async () => {
    const person = await invited();
    expect(await auth.setStatus({ operator: ops, userId: person.userId, disabled: false, requestId: s.rid() })).toEqual({ ok: false, code: "already_in_state" });
    expect(await auth.setRole({ operator: ops, userId: person.userId, role: "agent", requestId: s.rid() })).toEqual({ ok: false, code: "already_in_state" });
    expect(await auth.setStatus({ operator: ops, userId: "00000000-0000-4000-8000-000000000000", disabled: true, requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
  });

  it("clears out spent and expired credentials after a week, and nothing newer", async () => {
    const person = await invited();
    await sql`update client_login_tokens set created_at = now() - interval '10 days', expires_at = now() - interval '9 days' where user_id = ${person.userId}`.execute(t.admin);
    const me = await signedIn();
    const cleaned = await auth.cleanUp();
    expect(cleaned.links).toBeGreaterThanOrEqual(1);
    expect(await auth.resolve(me.sessionToken)).toBeDefined();
  });
});
