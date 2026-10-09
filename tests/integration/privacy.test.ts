import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createInboxService } from "../../src/modules/inbox";
import { suppressionHmac } from "../../src/modules/privacy";
import pino from "pino";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { insertRawLead } from "../helpers/raw";
import { buildStage3, HASH_KEY } from "../helpers/stage3";

/**
 * Privacy actions (stage 3): withdrawing consent and erasing a lead. What must hold: personal data is really gone (not just
 * hidden), the person is remembered only as a KEYED hash, any business holding the lead is told, nothing is half-done, a repeat
 * is harmless, and only an owner may erase.
 */
let t: TestDatabase;
let s: ReturnType<typeof buildStage3>;
let staff: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
let owner: typeof staff;
let br6Client: string;
const PHONE = "+447911700123";

beforeAll(async () => {
  t = await createTestDatabase();
  s = buildStage3(t);
  staff = await s.operator("staff@example.com", "staff");
  owner = await s.operator("owner@example.com", "owner");
  br6Client = await s.activeClient(owner, { name: "Holder Electrical" });
  await s.setPrice(owner, 3500);
});
afterAll(async () => {
  await t.destroy();
});

let emailCounter = 0;
/** Each lead is a DIFFERENT person unless a test says otherwise: suppression is per identity, and tests must not share one. */
const lead = (overrides: Parameters<typeof insertRawLead>[1] = {}) => {
  emailCounter += 1;
  return insertRawLead(t.admin, { phone: PHONE, email: `person${emailCounter}@example.com`, ...overrides });
};
const leadRow = (id: string) => t.admin.selectFrom("leads").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const contactRow = (id: string) => t.admin.selectFrom("lead_contacts").selectAll().where("lead_id", "=", id).executeTakeFirstOrThrow();
const events = (id: string, type?: string) => {
  let q = t.admin.selectFrom("lead_events").selectAll().where("lead_id", "=", id);
  if (type) q = q.where("type", "=", type);
  return q.orderBy("id").execute();
};
const auditOf = (id: string) => t.admin.selectFrom("audit_logs").selectAll().where("entity_id", "=", id).orderBy("id").execute();
const suppressionCount = async () => Number((await t.admin.selectFrom("suppressions").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow()).n);

describe("withdrawing consent", () => {
  it("records the withdrawal, suppresses the person as KEYED hashes, retires the lead, and does it for any operator", async () => {
    const l = await lead();
    const result = await s.privacy.withdrawConsent({ operator: staff, leadId: l.id, requestId: "req-withdraw" });
    expect(result).toEqual({ ok: true, alreadyDone: false, notify: [] });

    const records = await t.admin.selectFrom("consent_records").select(["event", "method"]).where("lead_id", "=", l.id).orderBy("captured_at").execute();
    expect(records).toEqual([{ event: "granted", method: "web_form_checkbox" }, { event: "withdrawn", method: "operator_request" }]);
    expect((await leadRow(l.id)).status).toBe("invalid");

    const email = (await contactRow(l.id)).email_normalised!;
    const rows = await t.admin.selectFrom("suppressions").select(["kind", "value_hmac", "reason"]).where("reason", "=", "withdrawn_consent").execute();
    expect(rows.find((row) => row.kind === "phone" && row.value_hmac === suppressionHmac(HASH_KEY, "phone", PHONE))).toBeDefined();
    expect(rows.find((row) => row.kind === "email" && row.value_hmac === suppressionHmac(HASH_KEY, "email", email))).toBeDefined();
    // The table must hold NO personal data and nothing a brute-force of phone numbers could reverse without the key.
    const stored = JSON.stringify(await t.admin.selectFrom("suppressions").selectAll().execute());
    expect(stored).not.toContain(PHONE);
    expect(stored).not.toContain(email);
    expect(stored).not.toContain(createHash("sha256").update(PHONE).digest("hex"));

    expect((await events(l.id, "lead.consent_withdrawn"))[0]).toMatchObject({ actor_type: "staff_user", actor_id: staff.id, request_id: "req-withdraw" });
    expect((await auditOf(l.id)).at(-1)).toMatchObject({ action: "privacy.consent_withdrawn", actor_id: staff.id });
    // Personal details stay until erased (withdrawal stops USE, erasure removes the data): the contact row is intact.
    expect((await contactRow(l.id)).phone_e164).toBe(PHONE);
  });

  it("takes the lead back from a business, and lists that business so the operator can tell them to stop", async () => {
    const l = await lead({ phone: "+447911700200" });
    const assigned = await s.assignments.assign({ operator: staff, leadId: l.id, clientId: br6Client, requestId: s.rid() });
    if (!assigned.ok) throw new Error("setup");
    await s.assignments.markSent({ operator: staff, assignmentId: assigned.assignmentId, requestId: s.rid() });

    const result = await s.privacy.withdrawConsent({ operator: staff, leadId: l.id, requestId: s.rid() });
    expect(result).toMatchObject({ ok: true, alreadyDone: false });
    if (!result.ok) return;
    expect(result.notify).toHaveLength(1);
    expect(result.notify[0]).toMatchObject({ clientId: br6Client, clientName: "Holder Electrical", status: "notified", reference: l.reference });

    expect(await t.admin.selectFrom("lead_assignments").select("status").where("lead_id", "=", l.id).executeTakeFirstOrThrow()).toEqual({ status: "cancelled" });
    const history = await t.admin.selectFrom("lead_assignment_status_history").selectAll().where("assignment_id", "=", assigned.assignmentId).orderBy("id").execute();
    expect(history.at(-1)).toMatchObject({ to_status: "cancelled", actor_id: staff.id, reason: "consent_withdrawn" });
    expect(await leadRow(l.id)).toMatchObject({ status: "invalid", assignments_count: 0 });
    expect(await s.assignments.handover(assigned.assignmentId)).toBeUndefined();
  });

  it("is harmless to repeat: no second consent record, no second suppression, no second event", async () => {
    const l = await lead({ phone: "+447911700300" });
    await s.privacy.withdrawConsent({ operator: staff, leadId: l.id, requestId: s.rid() });
    const before = { suppressions: await suppressionCount(), events: (await events(l.id)).length, audit: (await auditOf(l.id)).length };
    const again = await Promise.all(Array.from({ length: 6 }, () => s.privacy.withdrawConsent({ operator: staff, leadId: l.id, requestId: s.rid() })));
    expect(again.every((result) => result.ok && result.alreadyDone)).toBe(true);
    expect(await suppressionCount()).toBe(before.suppressions);
    expect((await events(l.id)).length).toBe(before.events);
    expect((await auditOf(l.id)).length).toBe(before.audit);
    expect((await t.admin.selectFrom("consent_records").select("id").where("lead_id", "=", l.id).where("event", "=", "withdrawn").execute())).toHaveLength(1);
  });

  it("reports an unknown lead, and RACES of 8 withdrawals produce exactly one", async () => {
    expect(await s.privacy.withdrawConsent({ operator: staff, leadId: crypto.randomUUID(), requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
    const l = await lead({ phone: "+447911700400" });
    const results = await Promise.all(Array.from({ length: 8 }, () => s.privacy.withdrawConsent({ operator: staff, leadId: l.id, requestId: s.rid() })));
    expect(results.filter((result) => result.ok && !result.alreadyDone)).toHaveLength(1);
    expect((await t.admin.selectFrom("consent_records").select("id").where("lead_id", "=", l.id).where("event", "=", "withdrawn").execute())).toHaveLength(1);
  });
});

describe("erasing a lead", () => {
  it("is for owners only: staff are refused and NOTHING changes", async () => {
    const l = await lead({ phone: "+447911710001" });
    expect(await s.privacy.erase({ operator: staff, leadId: l.id, reason: "consumer_request", requestId: s.rid() })).toEqual({ ok: false, code: "forbidden" });
    expect((await contactRow(l.id)).phone_e164).toBe("+447911710001");
    expect((await leadRow(l.id)).erased_at).toBeNull();
    expect(await events(l.id, "lead.erased")).toHaveLength(0);
  });

  it("needs a reason from the closed list", async () => {
    const l = await lead({ phone: "+447911710002" });
    for (const reason of ["", "please delete 07911 710002", "test"]) {
      expect(await s.privacy.erase({ operator: owner, leadId: l.id, reason, requestId: s.rid() })).toEqual({ ok: false, code: "invalid_reason" });
    }
    expect((await leadRow(l.id)).erased_at).toBeNull();
  });

  it("removes every personal field, keeps what is not personal and the consent evidence, and retires the lead", async () => {
    const l = await lead({ phone: "+447911710003" });
    await t.admin
      .insertInto("lead_attributions")
      .values({ lead_id: l.id, landing_path: "/quote?email=private.person@example.com", utm_term: "private.person", gclid: "click-private-person" })
      .execute();
    const result = await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: "req-erase" });
    expect(result).toEqual({ ok: true, alreadyDone: false, notify: [] });

    expect(await contactRow(l.id)).toMatchObject({ full_name: null, phone_e164: null, email: null, email_normalised: null, notes: null, ip: null, user_agent: null });
    expect((await contactRow(l.id)).erased_at).toBeInstanceOf(Date);
    const row = await leadRow(l.id);
    expect(row).toMatchObject({ postcode: null, postcode_outward: "BR6", status: "invalid" }); // the outward code is not personal and is kept for analytics
    expect(row.erased_at).toBeInstanceOf(Date);
    // Consent evidence is retained (a legal record of what was agreed), append-only.
    expect((await t.admin.selectFrom("consent_records").select("id").where("lead_id", "=", l.id).execute()).length).toBe(1);
    // Nothing reaches back to the person.
    expect(await s.assignments.handover(crypto.randomUUID())).toBeUndefined();
    expect(await s.assignments.candidates(l.id)).toMatchObject({ postcode: null, clients: [] });
    const attribution = await t.admin.selectFrom("lead_attributions").selectAll().where("lead_id", "=", l.id).executeTakeFirstOrThrow();
    expect(attribution).toMatchObject({
      landing_path: null, utm_term: null, utm_content: null, utm_source: null, utm_medium: null, utm_campaign: null,
      gclid: null, fbclid: null, msclkid: null, referrer_host: null,
    });
    expect(JSON.stringify(attribution)).not.toContain("private.person");
  });

  it("remembers the person only as keyed hashes, taken BEFORE the data was blanked", async () => {
    const phone = "+447911710004";
    const l = await lead({ phone });
    const email = (await contactRow(l.id)).email_normalised!;
    await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: s.rid() });
    const rows = await t.admin.selectFrom("suppressions").select(["kind", "value_hmac", "reason"]).where("reason", "=", "erasure").execute();
    expect(rows.map((row) => row.value_hmac)).toContain(suppressionHmac(HASH_KEY, "phone", phone));
    expect(rows.map((row) => row.value_hmac)).toContain(suppressionHmac(HASH_KEY, "email", email));
  });

  it("writes an event and an audit entry that contain NO personal data, naming the owner and the reason", async () => {
    const l = await lead({ phone: "+447911710005" });
    const email = (await contactRow(l.id)).email_normalised!;
    await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: "req-audit" });
    const everything = JSON.stringify([await events(l.id), await auditOf(l.id), await t.admin.selectFrom("lead_status_history").selectAll().where("lead_id", "=", l.id).execute()]);
    for (const secret of ["+447911710005", email, "Raw Fixture", "BR6 0AA"]) expect(everything).not.toContain(secret);
    expect((await events(l.id, "lead.erased"))[0]).toMatchObject({ actor_type: "staff_user", actor_id: owner.id, request_id: "req-audit", payload: { reason: "consumer_request" } });
    expect((await auditOf(l.id)).at(-1)).toMatchObject({ action: "privacy.lead_erased", actor_id: owner.id, reason: "consumer_request" });
  });

  it("takes the lead back from the business holding it, and tells the operator whom to notify", async () => {
    const l = await lead({ phone: "+447911710006" });
    const assigned = await s.assignments.assign({ operator: staff, leadId: l.id, clientId: br6Client, requestId: s.rid() });
    if (!assigned.ok) throw new Error("setup");
    const result = await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: s.rid() });
    expect(result).toMatchObject({ ok: true, notify: [{ clientId: br6Client, clientName: "Holder Electrical" }] });
    expect(await leadRow(l.id)).toMatchObject({ status: "invalid", assignments_count: 0 });
    expect((await t.admin.selectFrom("lead_assignment_status_history").selectAll().where("assignment_id", "=", assigned.assignmentId).orderBy("id").execute()).at(-1)).toMatchObject({ to_status: "cancelled", reason: "erasure_request", actor_id: owner.id });
  });

  it("works on a held lead and on a lead already screened out", async () => {
    const held = await lead({ phone: "+447911710007", status: "held", fraudDecision: "review" });
    expect((await s.privacy.erase({ operator: owner, leadId: held.id, reason: "test_data", requestId: s.rid() })).ok).toBe(true);
    expect((await leadRow(held.id)).status).toBe("invalid");
    const rejected = await lead({ phone: "+447911710008", status: "rejected_fraud", fraudDecision: "reject" });
    expect((await s.privacy.erase({ operator: owner, leadId: rejected.id, reason: "test_data", requestId: s.rid() })).ok).toBe(true);
    expect((await leadRow(rejected.id)).status).toBe("rejected_fraud"); // terminal statuses are left alone
    expect((await contactRow(rejected.id)).phone_e164).toBeNull();
  });

  it("is replay-safe: a repeat, and 8 simultaneous requests, erase once and leave one record of it", async () => {
    const l = await lead({ phone: "+447911710009" });
    const results = await Promise.all(Array.from({ length: 8 }, () => s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: s.rid() })));
    expect(results.filter((result) => result.ok && !result.alreadyDone)).toHaveLength(1);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(await events(l.id, "lead.erased")).toHaveLength(1);
    expect((await auditOf(l.id)).filter((entry) => entry.action === "privacy.lead_erased")).toHaveLength(1);
    expect(await s.privacy.erase({ operator: owner, leadId: crypto.randomUUID(), reason: "consumer_request", requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
  });

  it("shows an erased lead to the operator without contact details", async () => {
    const l = await lead({ phone: "+447911710010" });
    await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: s.rid() });
    const inbox = createInboxService({ db: t.db, logger: pino({ level: "silent" }) });
    const detail = (await inbox.detail(l.id))!;
    expect(detail.contact).toBeNull();
    expect(detail.postcode).toBeNull();
    expect(detail.postcodeOutward).toBe("BR6");
  });
});

describe("suppression has an effect: a business is never given a lead whose consumer has asked us to stop", () => {
  it("covers the same phone OR the same email, only for requests made after the enquiry", async () => {
    const early = await lead({ phone: "+447911720001", email: "shared.person@example.com" });
    const sameEmail = await lead({ phone: "+447911720002", email: "shared.person@example.com" }); // different phone, same email
    const samePhone = await lead({ phone: "+447911720001" });
    const unrelated = await lead({ phone: "+447911720003" });

    await s.privacy.withdrawConsent({ operator: staff, leadId: early.id, requestId: s.rid() });
    expect(await s.privacy.isSuppressed(t.db, sameEmail.id)).toBe(true); // matched by email
    expect(await s.privacy.isSuppressed(t.db, samePhone.id)).toBe(true); // matched by phone
    expect(await s.privacy.isSuppressed(t.db, unrelated.id)).toBe(false);
    expect(await s.privacy.isSuppressed(t.db, crypto.randomUUID())).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const later = await lead({ phone: "+447911720001", email: "shared.person@example.com" });
    expect(await s.privacy.isSuppressed(t.db, later.id)).toBe(false); // a NEW enquiry is fresh consent
  });

  it("their LATEST request to stop counts, even if they were suppressed before (erased, enquired again, then withdrew)", async () => {
    const phone = "+447911720010";
    const email = "comes.back@example.com";
    const first = await lead({ phone, email });
    await s.privacy.erase({ operator: owner, leadId: first.id, reason: "consumer_request", requestId: s.rid() }); // suppressed at T1
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await lead({ phone, email }); // enquires again at T2 > T1: fresh consent
    const sibling = await lead({ phone, email }); // and a second pending enquiry
    expect(await s.privacy.isSuppressed(t.db, second.id)).toBe(false);
    expect(await s.privacy.isSuppressed(t.db, sibling.id)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await s.privacy.withdrawConsent({ operator: staff, leadId: second.id, requestId: s.rid() }); // asks us to stop at T3
    // Without refreshing the timestamp the T1 row would still say "before the enquiry": the sibling would be handed over.
    expect(await s.privacy.isSuppressed(t.db, sibling.id)).toBe(true);
    // The first request and its reason are kept; only the latest request time moves.
    const row = await t.admin.selectFrom("suppressions").select(["reason", "created_at", "last_requested_at"]).where("value_hmac", "=", suppressionHmac(HASH_KEY, "phone", phone)).executeTakeFirstOrThrow();
    expect(row.reason).toBe("erasure");
    expect(row.last_requested_at.getTime()).toBeGreaterThan(row.created_at.getTime());
  });

  it("an erased lead has nothing left to match", async () => {
    const l = await lead({ phone: "+447911720004" });
    await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: s.rid() });
    expect(await s.privacy.isSuppressed(t.db, l.id)).toBe(false);
  });
});

describe("re-applying erasures after a backup restore", () => {
  /** What a restore does: the database comes back as it was BEFORE the erasure. Simulated by putting the data back. */
  async function restoreFromBackup(leadId: string, original: { phone: string; email: string; name: string }) {
    await t.admin.transaction().execute(async (trx) => {
      await sql`alter table leads disable trigger user`.execute(trx);
      await trx.updateTable("lead_contacts").set({ full_name: original.name, phone_e164: original.phone, email: original.email, email_normalised: original.email, erased_at: null }).where("lead_id", "=", leadId).execute();
      await trx.updateTable("leads").set({ postcode: "BR6 0AA", erased_at: null }).where("id", "=", leadId).execute();
      await sql`alter table leads enable trigger user`.execute(trx);
    });
  }

  it("replays an erasure idempotently as the SYSTEM, re-blanking the restored data and re-suppressing the person", async () => {
    const phone = "+447911730001";
    const l = await lead({ phone });
    const originalEmail = (await contactRow(l.id)).email_normalised!;
    await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: s.rid() });
    await restoreFromBackup(l.id, { phone, email: originalEmail, name: "Raw Fixture" });
    expect((await contactRow(l.id)).phone_e164).toBe(phone); // the restore resurrected the person

    const replay = await s.privacy.replayErasure({ leadId: l.id, requestId: "req-replay" });
    expect(replay).toMatchObject({ ok: true, alreadyDone: false });
    expect(await contactRow(l.id)).toMatchObject({ full_name: null, phone_e164: null, email: null });
    expect((await leadRow(l.id)).postcode).toBeNull();
    expect((await auditOf(l.id)).at(-1)).toMatchObject({ action: "privacy.lead_erased", actor_type: "system", actor_id: null });

    // Replaying again, or for an already-erased lead, changes nothing.
    expect(await s.privacy.replayErasure({ leadId: l.id, requestId: s.rid() })).toMatchObject({ ok: true, alreadyDone: true });
    expect(await s.privacy.replayErasure({ leadId: crypto.randomUUID(), requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
  });
});

describe("scripts/replay-erasures.ts (what the operator runs after a real restore)", () => {
  const root = path.resolve(import.meta.dirname, "../..");

  function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/replay-erasures.ts", ...args], {
        cwd: root,
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: t.appUrl, PRIVACY_HASH_KEY: HASH_KEY, ...env },
      });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (output += chunk));
      child.on("exit", (code) => resolve({ code, output }));
    });
  }

  it("reports by default and changes nothing; with --apply it re-erases the people the logs say were erased", async () => {
    const phone = "+447911740001";
    const l = await lead({ phone });
    const original = (await contactRow(l.id)).email_normalised!;
    await s.privacy.erase({ operator: owner, leadId: l.id, reason: "consumer_request", requestId: s.rid() });
    await t.admin.transaction().execute(async (trx) => {
      await sql`alter table leads disable trigger user`.execute(trx);
      await trx.updateTable("lead_contacts").set({ full_name: "Raw Fixture", phone_e164: phone, email: original, email_normalised: original, erased_at: null }).where("lead_id", "=", l.id).execute();
      await trx.updateTable("leads").set({ postcode: "BR6 0AA", erased_at: null }).where("id", "=", l.id).execute();
      await sql`alter table leads enable trigger user`.execute(trx);
    });

    const directory = mkdtempSync(path.join(tmpdir(), "replay-"));
    const logFile = path.join(directory, "app.log");
    writeFileSync(logFile, [
      JSON.stringify({ level: "warn", service: "leadgen-web", msg: "privacy: lead erased", leadId: l.id, action: "lead_erased" }),
      JSON.stringify({ level: "warn", msg: "privacy: lead erased", leadId: crypto.randomUUID() }), // a lead created after the backup: not in this database
      "garbage line",
    ].join("\n"));

    const dry = await run([logFile]);
    expect(dry.code).toBe(0);
    expect(dry.output).toContain("DRY RUN");
    expect(dry.output).toContain("1 not yet erased here");
    expect(dry.output).toContain("1 not in this database");
    expect((await contactRow(l.id)).phone_e164).toBe(phone); // untouched

    const applied = await run([logFile, "--apply"]);
    expect(applied.code).toBe(0);
    expect(applied.output).toContain("re-applied 1");
    expect(await contactRow(l.id)).toMatchObject({ full_name: null, phone_e164: null, email: null });
    expect((await auditOf(l.id)).at(-1)).toMatchObject({ action: "privacy.lead_erased", actor_type: "system" });
    // No personal data in what the script printed.
    for (const secret of [phone, original, "Raw Fixture"]) expect(applied.output + dry.output).not.toContain(secret);

    const again = await run([logFile, "--apply"]);
    expect(again.output).toContain("0 not yet erased here");
    expect(again.output).toContain("re-applied 0");
  }, 60_000);

  it("refuses to run without the application's hash key, and without a log file", async () => {
    expect((await run(["/nonexistent.log"], { PRIVACY_HASH_KEY: "short" })).code).toBe(1);
    expect((await run([])).code).toBe(2);
  }, 30_000);
});
