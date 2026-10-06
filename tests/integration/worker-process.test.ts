import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { startFakeResend, type FakeResend } from "../helpers/fake-resend";
import { buildLeadService, command, validSubmission } from "../helpers/fixtures";
import { startFakeTwilio, startWebhookReceiver, type FakeTwilio, type WebhookReceiver } from "../helpers/fake-delivery";
import { buildStage3 } from "../helpers/stage3";
import { createClientService } from "../../src/modules/clients";
import { verifyWebhookSignature } from "../../src/lib/secrets";
import { randomBytes } from "node:crypto";

/**
 * The stage-2 acceptance criteria, against the REAL worker process (src/workers/main.ts) talking to
 * a real database through the restricted application role and to a fake HTTP email provider:
 *
 *   "kill the worker mid-send and the alert is still delivered exactly once or retried, never lost"
 *   "a restore is not needed to recover: a restarted worker finishes the job"
 *   "the worker refuses to start with bad configuration and never prints a secret"
 *
 * Slower than the rest (it boots Node and TypeScript for each worker), so it holds only what cannot
 * be proven in-process.
 */
const root = path.resolve(import.meta.dirname, "../..");
let t: TestDatabase;
let fake: FakeResend;
let n = 60_000;
const next = () => (n += 1);

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});
beforeEach(async () => {
  fake = await startFakeResend();
  await sql`update operator_alerts set status = 'cancelled', locked_until = null where status in ('pending', 'retrying', 'sending')`.execute(t.admin);
});

interface WorkerProcess {
  child: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
const spawned: ChildProcess[] = [];
afterEach(async () => {
  for (const child of spawned.splice(0)) child.kill("SIGKILL");
  await fake.close();
});

function startWorkerProcess(overrides: Record<string, string> = {}, options: { omit?: string[] } = {}): WorkerProcess {
  const env: Record<string, string> & { NODE_ENV: "test" } = {
    // NODE_ENV=test also stops the child reading .env.local: it gets exactly the settings below.
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LC_ALL: "en_US.UTF-8",
    APP_ENV: "test",
    LOG_LEVEL: "info",
    DATABASE_URL: t.appUrl,
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "re_test_key_123456",
    RESEND_BASE_URL: fake.url,
    EMAIL_FROM: "Test Brand <alerts@mail.example.com>",
    OPERATOR_ALERT_EMAILS: "ops@example.com",
    ADMIN_BASE_URL: "https://admin.test.example",
    // Short timings so recovery is observable in seconds; the defaults are exercised by the unit tests.
    WORKER_LEASE_SECONDS: "3",
    WORKER_POLL_MS: "200",
    WORKER_RECONCILE_MS: "500",
    WORKER_GRACE_SECONDS: "1",
    ...overrides,
  };
  for (const key of options.omit ?? []) delete (env as Record<string, string>)[key];

  const child = spawn(process.execPath, ["--import", "tsx", "src/workers/main.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  spawned.push(child);
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
  child.stderr!.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, output: () => buffer, exited };
}

const waitFor = (condition: () => boolean | Promise<boolean>, timeout = 15_000) => expect.poll(condition, { timeout, interval: 50 }).toBe(true);
const started = (worker: WorkerProcess) => waitFor(() => worker.output().includes("worker started"), 20_000);
const submit = (overrides = {}) => buildLeadService(t.db).submit(command(validSubmission(overrides, next())));
const alertFor = (leadId: string) => t.admin.selectFrom("operator_alerts").selectAll().where("lead_id", "=", leadId).executeTakeFirstOrThrow();

describe("the real worker process", () => {
  it("emails the operator for a new lead within seconds, using the real HTTP adapter", async () => {
    const worker = startWorkerProcess();
    await started(worker);

    const begun = performance.now();
    const lead = await submit();
    await waitFor(() => fake.delivered.length === 1, 5_000);
    const elapsed = performance.now() - begun;

    const email = fake.delivered[0]!;
    expect(email.authorization).toBe("Bearer re_test_key_123456");
    expect(email.body.to).toEqual(["ops@example.com"]);
    expect(email.body.from).toBe("Test Brand <alerts@mail.example.com>");
    expect(email.body.subject).toContain(lead.reference);
    expect(email.body.text).toContain(`https://admin.test.example/admin/leads/${lead.leadId}`);
    await waitFor(async () => (await alertFor(lead.leadId)).status === "sent");
    expect(elapsed).toBeLessThan(3_000); // the objective is p95 < 10 s end to end; this is the local floor
  });

  it("KILLED MID-SEND (SIGKILL), the alert is not lost and exactly one email exists after a replacement worker takes over", async () => {
    // First send: the provider ACCEPTS the email, then the answer is held for 10 s: the worker is
    // killed while waiting, so it never records success. The worst case for duplicates.
    fake.queue({ status: 200, deliverEarly: true, delayMs: 10_000 });

    const first = startWorkerProcess();
    await started(first);
    const lead = await submit();
    await waitFor(() => fake.requests.length === 1, 10_000);
    expect(fake.delivered).toHaveLength(1); // the provider really did accept it

    first.child.kill("SIGKILL");
    expect((await first.exited).signal).toBe("SIGKILL");
    expect(await alertFor(lead.leadId)).toMatchObject({ status: "sending", attempt_count: 1 }); // stranded under a lease

    // A replacement worker starts (the platform restarts crashed containers). It must finish the job.
    const second = startWorkerProcess();
    await started(second);
    await waitFor(async () => (await alertFor(lead.leadId)).status === "sent", 20_000);

    const alert = await alertFor(lead.leadId);
    expect(alert.attempt_count).toBe(2);
    expect(fake.requests).toHaveLength(2); // it DID try again (it could not know the first had succeeded)...
    expect(fake.requests[0]!.idempotencyKey).toBe(fake.requests[1]!.idempotencyKey);
    expect(fake.delivered).toHaveLength(1); // ...but the shared idempotency key meant the provider sent ONE email
    const attempts = await t.admin.selectFrom("operator_alert_attempts").select(["attempt_no", "outcome"]).where("alert_id", "=", alert.id).orderBy("attempt_no").execute();
    expect(attempts).toEqual([
      { attempt_no: 1, outcome: "abandoned" },
      { attempt_no: 2, outcome: "accepted" },
    ]);
    expect(second.output()).toContain("reclaimed operator alerts whose worker disappeared");
  });

  it("with the provider down, nothing is lost: it retries and delivers once the provider recovers", async () => {
    fake.queue({ status: 503, body: {} }, { status: 503, body: {} });
    const worker = startWorkerProcess();
    await started(worker);
    const lead = await submit();

    await waitFor(async () => (await alertFor(lead.leadId)).status === "retrying", 5_000);
    expect((await alertFor(lead.leadId)).last_error_code).toBe("http_503");
    // Retry delays are 5 s then 15 s (+-20%): shorten the wait by making them due.
    for (let round = 0; round < 3 && fake.delivered.length === 0; round += 1) {
      await sql`update operator_alerts set next_attempt_at = now() where status = 'retrying'`.execute(t.admin);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    await waitFor(() => fake.delivered.length === 1, 10_000);
    await waitFor(async () => (await alertFor(lead.leadId)).status === "sent");
    expect((await alertFor(lead.leadId)).attempt_count).toBe(3);
  });

  it("a lead that nobody was told about (enqueue never happened) is alerted by the reconciler within the grace period", async () => {
    // Simulate "the alert row was lost": a lead exists, the alert row does not.
    const lead = await submit();
    await sql`delete from operator_alerts where lead_id = ${lead.leadId}`.execute(t.admin);
    await sql`update leads set created_at = now() - interval '2 minutes' where id = ${lead.leadId}`.execute(t.admin);

    const worker = startWorkerProcess();
    await started(worker);
    await waitFor(() => fake.delivered.length === 1, 10_000);
    expect(fake.delivered[0]!.body.subject).toContain((await t.admin.selectFrom("leads").select("reference").where("id", "=", lead.leadId).executeTakeFirstOrThrow()).reference);
    expect(worker.output()).toContain("should already exist"); // and it says so loudly
  });

  it("shuts down cleanly on SIGTERM: exit code 0 and no heartbeat left behind", async () => {
    const worker = startWorkerProcess();
    await started(worker);
    // Worker ids end -<pid>-<random>; earlier tests' SIGKILLed workers legitimately leave stale rows behind.
    const mine = () => t.admin.selectFrom("worker_heartbeats").select("worker_id").where(sql<boolean>`worker_id like ${`%-${worker.child.pid}-%`}`).execute();
    expect(await mine()).toHaveLength(1);

    worker.child.kill("SIGTERM");
    expect(await worker.exited).toEqual({ code: 0, signal: null });
    expect(worker.output()).toContain("worker stopped");
    expect(await mine()).toHaveLength(0);
  });

  it("keeps personal data out of its own logs for a full lead", async () => {
    const worker = startWorkerProcess();
    await started(worker);
    const marker = next();
    const phone = `07911 1${String(marker).slice(-5)}`;
    const email = `quillfeather.${marker}@leaktest.example`;
    await submit({ contact: { name: "Zebediah Quillfeather", phone, email, notes: "Gate code 4821" } });
    await waitFor(() => fake.delivered.length === 1, 5_000);
    // Make a failure path run too, since error logs are where personal data tends to leak.
    fake.queue({ status: 500 });
    await submit({ contact: { name: "Zebediah Quillfeather", phone: `07911 2${String(marker).slice(-5)}`, email: `q2.${marker}@leaktest.example`, notes: "Gate code 4821" } });
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const logs = worker.output();
    for (const secret of ["Zebediah", "Quillfeather", phone.replace(/\s/g, ""), phone, "leaktest.example", "Gate code", "4821", "BR6 0AA", "re_test_key_123456"]) {
      expect(logs, `worker logged "${secret}"`).not.toContain(secret);
    }
    expect(logs).toContain("operator alert sent");
  });
});

describe("refusing to start", () => {
  it("exits 1 with the names (never the values) of bad settings", async () => {
    const worker = startWorkerProcess({ DATABASE_URL: "postgres://user:hunter2secret@127.0.0.1:1/x", EMAIL_PROVIDER: "resend" }, { omit: ["RESEND_API_KEY"] });
    const { code } = await worker.exited;
    expect(code).toBe(1);
    expect(worker.output()).toContain("RESEND_API_KEY");
    expect(worker.output()).not.toContain("hunter2secret");
  });

  it("refuses the console provider in production, where it would silently send nothing", async () => {
    const worker = startWorkerProcess({ APP_ENV: "production", EMAIL_PROVIDER: "console", APP_URL: "https://www.example-electrical.co.uk" });
    expect((await worker.exited).code).toBe(1);
    expect(worker.output()).toContain("EMAIL_PROVIDER");
  });
});

describe("the real worker process routes leads (stage 4)", () => {
  let s: ReturnType<typeof buildStage3>;
  let owner: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
  let clientId: string;

  beforeAll(async () => {
    s = buildStage3(t);
    owner = await s.operator("owner@process.test", "owner");
    await s.setPrice(owner);
    clientId = await s.activeClient(owner, { name: "Process Electrical" });
  });

  const switchRouting = async (enabled: boolean) => {
    const { createRoutingService } = await import("../../src/modules/routing");
    const pino = (await import("pino")).default;
    const routing = createRoutingService({ db: t.db, logger: pino({ level: "silent" }), verticalSlug: "electrical", isSuppressed: s.privacy.isSuppressed });
    const result = await routing.setEnabled({ operator: owner, enabled, requestId: s.rid() });
    if (!result.ok) throw new Error(result.code);
  };
  const leadStatus = async (leadId: string) => (await t.admin.selectFrom("leads").select("status").where("id", "=", leadId).executeTakeFirstOrThrow()).status;

  it("assigns a new lead within seconds, through NOTIFY, as the restricted application role", async () => {
    await switchRouting(true);
    const worker = startWorkerProcess();
    await started(worker);
    const begun = performance.now();
    const lead = await submit();
    await waitFor(async () => (await leadStatus(lead.leadId)) === "assigned", 5_000);
    expect(performance.now() - begun).toBeLessThan(3_000);
    const assignment = await t.admin.selectFrom("lead_assignments").select(["client_id", "assigned_by", "price_pence"]).where("lead_id", "=", lead.leadId).executeTakeFirstOrThrow();
    expect(assignment).toMatchObject({ client_id: clientId, assigned_by: "router", price_pence: 3500 });
  });

  it("KILLED MID-ROUTE (SIGKILL), the lead is untouched, and a replacement worker routes it: nothing needs recovering", async () => {
    await switchRouting(true);

    // Hold the business's row so the worker blocks half way through its routing transaction.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const blocker = t.admin.transaction().execute(async (trx) => {
      await sql`select 1 from clients where id = ${clientId} for update`.execute(trx);
      held();
      await gate;
    });
    await holding;

    const doomed = startWorkerProcess();
    await started(doomed);
    const lead = await submit();
    await waitFor(async () => {
      const { rows } = await sql<{ n: string }>`select count(*) n from pg_stat_activity where application_name = 'leadgen-worker' and wait_event_type = 'Lock'`.execute(t.admin);
      return Number(rows[0]!.n) > 0;
    }, 10_000);
    doomed.child.kill("SIGKILL");
    await doomed.exited;
    release();
    await blocker;

    expect(await leadStatus(lead.leadId)).toBe("new");
    expect(await t.admin.selectFrom("routing_runs").select("id").where("lead_id", "=", lead.leadId).execute()).toHaveLength(0);
    expect(await t.admin.selectFrom("lead_assignments").select("id").where("lead_id", "=", lead.leadId).execute()).toHaveLength(0);

    const replacement = startWorkerProcess();
    await started(replacement);
    await waitFor(async () => (await leadStatus(lead.leadId)) === "assigned", 8_000);
    expect(await t.admin.selectFrom("lead_assignments").select("id").where("lead_id", "=", lead.leadId).execute()).toHaveLength(1);
  });

  it("refuses to start without the privacy key when deployed (the router must see the web process's suppressions)", async () => {
    const worker = startWorkerProcess(
      { APP_ENV: "production", APP_URL: "https://www.example.com", SENTRY_DSN: "https://publickey@o0.ingest.sentry.io/1", ADMIN_BASE_URL: "https://admin.example.com/" },
      { omit: ["RESEND_BASE_URL", "PRIVACY_HASH_KEY"] },
    );
    const { code } = await worker.exited;
    expect(code).toBe(1);
    expect(worker.output()).toContain("PRIVACY_HASH_KEY");
  });
});

describe("the real worker process delivers to a business (stage 5)", () => {
  let s: ReturnType<typeof buildStage3>;
  let owner: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
  let twilio: FakeTwilio;
  let receiver: WebhookReceiver;
  const secretsKey = randomBytes(32);
  let secret: string;
  let clientId: string;

  beforeAll(async () => {
    s = buildStage3(t);
    owner = await s.operator("owner@delivery-process.test", "owner");
    await s.setPrice(owner);
  });
  beforeEach(async () => {
    twilio = await startFakeTwilio();
    receiver = await startWebhookReceiver();
    const clients = createClientService({ db: t.db, logger: (await import("pino")).default({ level: "silent" }), verticalSlug: "electrical", secretsKey });
    clientId = await s.activeClient(owner, { name: `Delivery ${next()}` });
    const rotated = await clients.rotateWebhookSecret({ operator: owner, clientId, requestId: s.rid() });
    if (!rotated.ok) throw new Error(rotated.code);
    secret = rotated.secret;
    const saved = await clients.setDeliverySettings({ operator: owner, clientId, settings: { mode: "automatic", email: true, sms: true, webhook: true, webhookUrl: "https://crm.example.com/hook" }, requestId: s.rid() });
    if (!saved.ok) throw new Error(saved.code);
    // A business's real address is https (a CHECK says so). The test receiver is plain http on loopback, which only the test-only worker setting
    // allows, so in THIS test database (private to this file) the CHECK is dropped and the receiver's address stored.
    await sql`alter table clients drop constraint if exists clients_webhook_url_chk`.execute(t.admin);
    await t.admin.updateTable("clients").set({ webhook_url: receiver.url }).where("id", "=", clientId).execute();
  });
  afterEach(async () => {
    await twilio.close();
    await receiver.close();
  });

  const deliveryEnv = () => ({
    DELIVERY_SECRETS_KEY: secretsKey.toString("base64"),
    TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`, TWILIO_API_KEY_SECRET: "twilio-key-secret-0123456789", TWILIO_MESSAGING_SERVICE_SID: `MG${"c".repeat(32)}`,
    TWILIO_BASE_URL: twilio.url, WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS: "true",
  });
  const assignOne = async () => {
    const lead = await submit();
    const result = await s.assignments.assign({ operator: owner, leadId: lead.leadId, clientId, requestId: s.rid() });
    if (!result.ok) throw new Error(result.code);
    return { ...lead, assignmentId: result.assignmentId };
  };
  const assignmentStatus = async (id: string) => (await t.admin.selectFrom("lead_assignments").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;

  it("sends the email, the text and the signed webhook within seconds, and marks the assignment notified", async () => {
    const worker = startWorkerProcess(deliveryEnv());
    await started(worker);

    const begun = performance.now();
    const lead = await assignOne();
    await waitFor(async () => (await assignmentStatus(lead.assignmentId)) === "notified", 8_000);
    expect(performance.now() - begun).toBeLessThan(5_000);

    expect(twilio.messages).toHaveLength(1);
    expect(twilio.messages[0]!.form.Body).toContain(lead.reference);
    expect(twilio.messages[0]!.form.StatusCallback).toMatch(/\/api\/webhooks\/twilio$/);
    expect(fake.delivered.some((mail) => mail.body.text?.includes(lead.reference) && mail.body.to?.[0]?.endsWith("@electrician.example"))).toBe(true);
    expect(receiver.requests).toHaveLength(1);
    const call = receiver.requests[0]!;
    expect(verifyWebhookSignature(secret, Number(call.headers["x-leadgen-timestamp"]), call.body, String(call.headers["x-leadgen-signature"]))).toBe(true);
    expect(JSON.parse(call.body).lead.reference).toBe(lead.reference);
    // `notified` means ONE channel got through; the other two may still be mid-send at that instant, so wait for all three.
    const channels = () => t.admin.selectFrom("notifications").select(["channel", "status"]).where("assignment_id", "=", lead.assignmentId).orderBy("channel").execute();
    await waitFor(async () => (await channels()).every((row) => row.status === "sent"), 5_000);
    expect(await channels()).toEqual([{ channel: "email", status: "sent" }, { channel: "sms", status: "sent" }, { channel: "webhook", status: "sent" }]);
  });

  it("KILLED MID-DELIVERY (SIGKILL) while the business's server is hanging: the lead is still delivered after a replacement takes over (at least once, with the same delivery id)", async () => {
    await t.admin.updateTable("clients").set({ notify_email: false, notify_sms: false }).where("id", "=", clientId).execute();
    receiver.holdNext(20_000);
    const first = startWorkerProcess(deliveryEnv());
    await started(first);
    const lead = await assignOne();
    await waitFor(() => receiver.requests.length === 1, 8_000); // the worker is now stuck waiting for the business's server
    first.child.kill("SIGKILL");
    await first.exited;
    expect(await assignmentStatus(lead.assignmentId)).toBe("reserved");

    const second = startWorkerProcess(deliveryEnv());
    await started(second);
    await waitFor(async () => (await assignmentStatus(lead.assignmentId)) === "notified", 15_000); // the 3 s lease expires, the reconciler requeues, the replacement sends
    expect(receiver.requests.length).toBeGreaterThanOrEqual(2);
    expect(new Set(receiver.requests.map((request) => request.headers["x-leadgen-delivery"])).size).toBe(1); // same id: the receiver can de-duplicate
    const attempts = await t.admin.selectFrom("notification_attempts").select("outcome").orderBy("id", "desc").limit(2).execute();
    expect(attempts.map((attempt) => attempt.outcome).sort()).toEqual(["abandoned", "accepted"]);
  }, 40_000);

  it("a business's server that keeps failing never blocks other businesses, and the lead is freed when every way gives up", async () => {
    await t.admin.updateTable("clients").set({ notify_email: false, notify_sms: false }).where("id", "=", clientId).execute();
    // Routing is left ON by the router tests above. With it on, the freed lead is (correctly) given straight to a different business
    // before this test can look at it (that is proved in delivery.test.ts), so switch it off to see the lead come back to `new`.
    await t.admin.updateTable("routing_settings").set({ enabled: false }).execute();
    receiver.answerNext(410);
    const worker = startWorkerProcess(deliveryEnv());
    await started(worker);
    const failing = await assignOne();
    await waitFor(async () => (await assignmentStatus(failing.assignmentId)) === "delivery_failed", 8_000); // 410 Gone: permanent, so nothing left to try
    const events = await t.admin.selectFrom("lead_events").select("type").where("lead_id", "=", failing.leadId).execute();
    expect(events.map((e) => e.type)).toContain("lead.delivery_failed");
    const leadStatus = (await t.admin.selectFrom("leads").select("status").where("id", "=", failing.leadId).executeTakeFirstOrThrow()).status;
    const history = await t.admin.selectFrom("lead_assignments").select(["client_id", "status"]).where("lead_id", "=", failing.leadId).orderBy("created_at").execute();
    expect({ leadStatus, history }).toEqual({ leadStatus: "new", history: [{ client_id: clientId, status: "delivery_failed" }] });
  }, 30_000);
});
