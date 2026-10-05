import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEAD_REFERENCE_PATTERN } from "../../src/lib/ids";
import {
  ChallengeFailedError,
  ConsentOutdatedError,
  IdempotencyConflictError,
  OutOfAreaError,
  PostcodeNotFoundError,
  ValidationError,
} from "../../src/lib/errors";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildLeadService, command, FakeChallenge, validSubmission, wirePayload } from "../helpers/fixtures";
import { parseLeadSubmission } from "../../src/modules/leads";

let t: TestDatabase;
let n = 100; // unique contact details per lead

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

const next = () => (n += 1);

async function leadByReference(reference: string) {
  return t.admin.selectFrom("leads").selectAll().where("reference", "=", reference).executeTakeFirstOrThrow();
}

async function countLeads(): Promise<number> {
  const row = await t.admin.selectFrom("leads").select(sql<string>`count(*)`.as("n")).executeTakeFirstOrThrow();
  return Number(row.n);
}

describe("creating a lead", () => {
  it("stores the lead with contact, consent, attribution, fraud signals, events and history in one transaction", async () => {
    const service = buildLeadService(t.db);
    const submission = validSubmission({ context: { pagePath: "/", attribution: { utmSource: "google", utmMedium: "cpc", utmCampaign: "2109", gclid: "EAIaIQ" } } }, next());
    const cmd = command(submission, { requestId: "req-create-1" });

    const result = await service.submit(cmd);
    expect(result.outcome).toBe("created");
    expect(result.status).toBe("new");
    expect(result.reference).toMatch(LEAD_REFERENCE_PATTERN);

    const lead = await leadByReference(result.reference);
    expect(lead).toMatchObject({
      status: "new",
      postcode: "BR6 0AA",
      postcode_outward: "BR6",
      property_type: "house",
      ownership: "owner",
      urgency: "within_2_weeks",
      details: { scope: "leak" },
      fraud_score: 0,
      fraud_decision: "accept",
      duplicate_of_lead_id: null,
      is_test: false,
    });

    const source = await t.admin.selectFrom("lead_sources").select("slug").where("id", "=", lead.source_id).executeTakeFirstOrThrow();
    expect(source.slug).toBe("google_ads");

    const contact = await t.admin.selectFrom("lead_contacts").selectAll().where("lead_id", "=", lead.id).executeTakeFirstOrThrow();
    expect(contact).toMatchObject({
      full_name: "Alex Example",
      phone_e164: submission.contact.phone.e164,
      email_normalised: submission.contact.email.toLowerCase(),
      ip: cmd.request.ip,
    });

    const consent = await t.admin
      .selectFrom("consent_records as c")
      .innerJoin("consent_texts as x", "x.id", "c.consent_text_id")
      .select(["c.event", "c.page_path", "c.ip", "x.version", "x.max_recipients"])
      .where("c.lead_id", "=", lead.id)
      .executeTakeFirstOrThrow();
    expect(consent).toEqual({ event: "granted", page_path: "/", ip: cmd.request.ip, version: "v1", max_recipients: 1 });

    const attribution = await t.admin.selectFrom("lead_attributions").selectAll().where("lead_id", "=", lead.id).executeTakeFirstOrThrow();
    expect(attribution).toMatchObject({ utm_source: "google", utm_campaign: "2109", gclid: "EAIaIQ" });

    const events = await t.admin.selectFrom("lead_events").select(["type", "actor_type", "request_id"]).where("lead_id", "=", lead.id).orderBy("id").execute();
    expect(events).toEqual([
      { type: "lead.received", actor_type: "consumer", request_id: "req-create-1" },
      { type: "lead.screened", actor_type: "system", request_id: "req-create-1" },
    ]);

    const history = await t.admin.selectFrom("lead_status_history").select(["from_status", "to_status", "actor_type", "request_id"]).where("lead_id", "=", lead.id).execute();
    expect(history).toEqual([{ from_status: null, to_status: "new", actor_type: "consumer", request_id: "req-create-1" }]);
  });

  it("never writes personal data into the event log or fraud evidence", async () => {
    const service = buildLeadService(t.db);
    const submission = validSubmission({ contact: { name: "Zebediah Quillfeather", notes: "Call after 6pm please" }, context: { honeypot: "" } }, next());
    const cmd = command(submission);
    const result = await service.submit(cmd);
    const lead = await leadByReference(result.reference);

    const events = await t.admin.selectFrom("lead_events").select("payload").where("lead_id", "=", lead.id).execute();
    const signals = await t.admin.selectFrom("lead_fraud_signals").select("detail").where("lead_id", "=", lead.id).execute();
    const blob = JSON.stringify([events, signals]);
    for (const secret of ["Zebediah", "Quillfeather", "Call after 6pm", submission.contact.phone.e164, submission.contact.email, cmd.request.ip ?? "no-ip"]) {
      expect(blob).not.toContain(secret);
    }
  });
});

describe("idempotency", () => {
  it("replays an identical retry: same reference, nothing new stored, challenge not repeated", async () => {
    const challenge = new FakeChallenge();
    const service = buildLeadService(t.db, challenge);
    const cmd = command(validSubmission({}, next()));

    const first = await service.submit(cmd);
    const before = await countLeads();
    const second = await service.submit(cmd);

    expect(first.outcome).toBe("created");
    expect(second).toMatchObject({ outcome: "replayed", reference: first.reference, leadId: first.leadId });
    expect(await countLeads()).toBe(before);
    expect(challenge.calls).toBe(1);
  });

  it("treats a retry with a fresh Turnstile token and different telemetry as the same submission", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const key = crypto.randomUUID();
    const first = await service.submit(command(validSubmission({}, k), { idempotencyKey: key }));
    const retry = await service.submit(
      command(validSubmission({ context: { turnstileToken: "another-token", elapsedMs: 99_000 } }, k), { idempotencyKey: key }),
    );
    expect(retry).toMatchObject({ outcome: "replayed", reference: first.reference });
  });

  it("refuses to reuse a key for different content, and stores nothing", async () => {
    const service = buildLeadService(t.db);
    const key = crypto.randomUUID();
    await service.submit(command(validSubmission({}, next()), { idempotencyKey: key }));
    const before = await countLeads();
    await expect(service.submit(command(validSubmission({}, next()), { idempotencyKey: key }))).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await countLeads()).toBe(before);
  });

  it("creates exactly ONE lead when the same request is fired 12 times concurrently", async () => {
    const service = buildLeadService(t.db);
    const cmd = command(validSubmission({}, next()));
    const before = await countLeads();

    const results = await Promise.all(Array.from({ length: 12 }, () => service.submit(cmd)));

    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(new Set(results.map((r) => r.reference)).size).toBe(1);
    expect(await countLeads()).toBe(before + 1);
  });
});

describe("duplicate prevention", () => {
  it("makes concurrent submissions of the same job (different keys) produce ONE live lead", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const before = await countLeads();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => service.submit(command(validSubmission({}, k)))),
    );

    expect(await countLeads()).toBe(before + 8);
    const rows = await t.admin.selectFrom("leads").select(["id", "reference", "status", "duplicate_of_lead_id"]).where("id", "in", results.map((r) => r.leadId)).execute();
    const live = rows.filter((row) => row.status === "new");
    const dupes = rows.filter((row) => row.status === "duplicate");
    expect(live).toHaveLength(1);
    expect(dupes).toHaveLength(7);
    expect(dupes.every((d) => d.duplicate_of_lead_id === live[0]?.id)).toBe(true);
    // Everyone is told the ORIGINAL enquiry's reference, so a quoted reference is always the live one.
    expect(new Set(results.map((r) => r.reference))).toEqual(new Set([live[0]?.reference]));
  });

  it("matches on email as well as phone", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const first = await service.submit(command(validSubmission({}, k)));
    const second = await service.submit(command(validSubmission({ contact: { phone: "07911 177777" } }, k)));
    expect(second.status).toBe("duplicate");
    expect(second.reference).toBe(first.reference);
  });

  it("does not treat a different job from the same person as a duplicate", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const a = await service.submit(command(validSubmission({ service: "roof_repair", scope: "leak" }, k)));
    const otherService = await service.submit(command(validSubmission({ service: "chimney", scope: "leadwork" }, k)));
    const otherArea = await service.submit(command(validSubmission({ postcode: "TN13 1AA" }, k)));
    expect(a.status).toBe("new");
    expect(otherService.status).toBe("new");
    expect(otherArea.status).toBe("new");
  });

  it("stops matching once the duplicate window has passed", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const first = await service.submit(command(validSubmission({ service: "flat_roof", scope: "replace" }, k)));
    await sql`update leads set created_at = now() - interval '20 days' where id = ${first.leadId}`.execute(t.admin);
    const again = await service.submit(command(validSubmission({ service: "flat_roof", scope: "replace" }, k)));
    expect(again.status).toBe("new");
  });

  it("does not let a bot's fraud-rejected attempt swallow the real person's retry", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    const bot = await service.submit(command(validSubmission({ service: "guttering_fascias", scope: "replace", context: { honeypot: "bot" } }, k)));
    const person = await service.submit(command(validSubmission({ service: "guttering_fascias", scope: "replace" }, k)));
    expect(bot.status).toBe("rejected_fraud");
    expect(person.status).toBe("new");
  });
});

describe("fraud screening decides the initial state", () => {
  it("rejects a filled honeypot but answers like a success, and keeps the evidence", async () => {
    const service = buildLeadService(t.db);
    const result = await service.submit(command(validSubmission({ context: { honeypot: "http://spam.example" } }, next())));
    expect(result.outcome).toBe("created");
    expect(result.reference).toMatch(LEAD_REFERENCE_PATTERN);
    const lead = await leadByReference(result.reference);
    expect(lead).toMatchObject({ status: "rejected_fraud", fraud_decision: "reject", fraud_score: 100 });
    const signals = await t.admin.selectFrom("lead_fraud_signals").select("code").where("lead_id", "=", lead.id).execute();
    expect(signals.map((s) => s.code)).toContain("honeypot_filled");
  });

  it("holds a lead in the review band for a human instead of routing or discarding it", async () => {
    const service = buildLeadService(t.db);
    const result = await service.submit(command(validSubmission({ context: { elapsedMs: 3_000 } }, next())));
    expect(result.status).toBe("held");
    const lead = await leadByReference(result.reference);
    expect(lead).toMatchObject({ status: "held", fraud_decision: "review", fraud_score: 50 });
  });

  it("accepts a flagged lead (it is still routed) but records the decision", async () => {
    const service = buildLeadService(t.db);
    const result = await service.submit(command(validSubmission({ contact: { email: `person${next()}@mailinator.com` } }, next())));
    expect(result.status).toBe("new");
    expect(await leadByReference(result.reference)).toMatchObject({ fraud_decision: "flag", fraud_score: 30 });
  });

  it("holds a lead whose browser sent no challenge token, rather than losing it", async () => {
    const service = buildLeadService(t.db, new FakeChallenge({ status: "missing" }));
    const result = await service.submit(command(validSubmission({}, next())));
    expect(result.status).toBe("held");
  });

  it("keeps accepting leads (with a penalty) when verification is unavailable", async () => {
    const service = buildLeadService(t.db, new FakeChallenge({ status: "unavailable", reason: "http_500" }));
    const result = await service.submit(command(validSubmission({}, next())));
    expect(result.status).toBe("new");
    expect(await leadByReference(result.reference)).toMatchObject({ fraud_score: 20, fraud_decision: "accept" });
  });

  it("rejects an automation user agent combined with other signals", async () => {
    const service = buildLeadService(t.db);
    const result = await service.submit(command(validSubmission({ context: { elapsedMs: 1_000 } }, next()), { userAgent: "curl/8.7.1" }));
    expect(result.status).toBe("rejected_fraud");
  });

  it("escalates by IP velocity without ever rejecting on it alone", async () => {
    const service = buildLeadService(t.db);
    const ip = "198.51.100.99";
    const codesFor: string[][] = [];
    for (let i = 0; i < 7; i += 1) {
      const k = next();
      const result = await service.submit(command(validSubmission({ service: "other", scope: "need_advice" }, k), { ip }));
      const signals = await t.admin.selectFrom("lead_fraud_signals").select("code").where("lead_id", "=", result.leadId).execute();
      codesFor.push(signals.map((s) => s.code));
    }
    expect(codesFor[0]).toEqual([]);
    expect(codesFor[2]).toEqual([]);
    expect(codesFor[3]).toContain("ip_velocity_elevated");
    expect(codesFor[6]).toContain("ip_velocity_high");
  });

  it("flags a phone number that reappears with a different email (and vice versa)", async () => {
    const service = buildLeadService(t.db);
    const k = next();
    await service.submit(command(validSubmission({ service: "roof_inspection", scope: "condition_survey" }, k)));
    const sameEmailOtherPhone = await service.submit(command(validSubmission({ service: "chimney", scope: "unsure", contact: { phone: "07911 188888" } }, k)));
    const samePhoneOtherEmail = await service.submit(command(validSubmission({ service: "new_roof", scope: "unsure", contact: { email: `different${k}@example.com` } }, k)));
    const codesOf = async (id: string) => (await t.admin.selectFrom("lead_fraud_signals").select("code").where("lead_id", "=", id).execute()).map((s) => s.code);
    expect(await codesOf(sameEmailOtherPhone.leadId)).toContain("email_reused_with_other_identity");
    expect(await codesOf(samePhoneOtherEmail.leadId)).toContain("phone_reused_with_other_identity");
  });
});

describe("rejections store nothing", () => {
  it("rejects a failed challenge", async () => {
    const service = buildLeadService(t.db, new FakeChallenge({ status: "failed", codes: ["timeout-or-duplicate"] }));
    const before = await countLeads();
    await expect(service.submit(command(validSubmission({}, next())))).rejects.toBeInstanceOf(ChallengeFailedError);
    expect(await countLeads()).toBe(before);
  });

  it("rejects postcodes outside the footprint, and ones that do not exist inside it", async () => {
    const service = buildLeadService(t.db);
    const before = await countLeads();
    await expect(service.submit(command(validSubmission({ postcode: "SW1A 1AA" }, next())))).rejects.toBeInstanceOf(OutOfAreaError);
    await expect(service.submit(command(validSubmission({ postcode: "BR6 9ZZ" }, next())))).rejects.toBeInstanceOf(PostcodeNotFoundError);
    expect(await countLeads()).toBe(before);
  });

  it("rejects outdated consent wording", async () => {
    const service = buildLeadService(t.db);
    const stale = parseLeadSubmission(wirePayload({ consent: { textVersion: "v999" } }, next()));
    await expect(service.submit(command(stale))).rejects.toBeInstanceOf(ConsentOutdatedError);
  });

  it("rejects a service an operator has switched off (after the reference cache refreshes)", async () => {
    await t.admin.updateTable("service_types").set({ active: false }).where("slug", "=", "chimney").execute();
    const service = buildLeadService(t.db);
    await expect(service.submit(command(validSubmission({ service: "chimney", scope: "unsure" }, next())))).rejects.toBeInstanceOf(ValidationError);
    await t.admin.updateTable("service_types").set({ active: true }).where("slug", "=", "chimney").execute();
  });
});

describe("hostile input", () => {
  it("stores injection and script payloads in free text as inert data (parameterised SQL, no interpretation)", async () => {
    const service = buildLeadService(t.db);
    const hostile = "Robert'); DROP TABLE leads;-- <script>alert(1)</script> ${process.env.DATABASE_URL} {{7*7}} \u0007bell";
    const result = await service.submit(command(validSubmission({ contact: { notes: hostile } }, next())));

    const stored = await t.admin.selectFrom("lead_contacts").select("notes").where("lead_id", "=", result.leadId).executeTakeFirstOrThrow();
    // Only the control character is removed; everything else is kept verbatim as text.
    expect(stored.notes).toBe(hostile.replace("\u0007", ""));
    expect(await countLeads()).toBeGreaterThan(0); // the table still exists and still has rows
  });

  it("rejects names that carry markup or SQL, because the name field only admits letters", async () => {
    for (const name of ["<script>alert(1)</script>", "x'; DROP TABLE leads;--", "a@b.c"]) {
      expect(() => validSubmission({ contact: { name } }, next())).toThrow();
    }
  });
});

