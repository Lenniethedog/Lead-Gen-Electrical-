// How long from "lead stored" to "the provider accepted the alert email", measured on the REAL worker process
// against a real PostgreSQL and a fake HTTP provider whose response latency you choose.
//
//   LOAD_DATABASE_URL=postgres://postgres@127.0.0.1:54329/leadgen_load PROVIDER_LATENCY_MS=250 npx tsx tests/load/alert-latency.mts
//
// !! Writes hundreds of leads. The database name MUST contain "load" (CREATE DATABASE leadgen_load TEMPLATE leadgen_dev):
// the script refuses anything else.
//
// What it does NOT measure: the real provider's latency (set PROVIDER_LATENCY_MS to what you observe from it),
// network distance between worker, database and provider, or a loaded database. It measures OUR pipeline.
import { spawn } from "node:child_process";
import path from "node:path";
import { sql } from "kysely";
import { createDb } from "../../src/lib/db/client";
import { startFakeResend } from "../helpers/fake-resend";
import { buildLeadService, command, validSubmission } from "../helpers/fixtures";

const url = process.env.LOAD_DATABASE_URL;
if (!url || !/\/[^/]*load[^/]*$/.test(new URL(url).pathname)) {
  console.error('Set LOAD_DATABASE_URL to a throw-away database whose name contains "load".');
  process.exit(2);
}
const latencyMs = Number(process.env.PROVIDER_LATENCY_MS ?? 0);
const root = path.resolve(import.meta.dirname, "../..");

const db = createDb({ url, poolMax: 10 });
const fake = await startFakeResend({ latencyMs });
// Leads copied from the template database are not part of the measurement (and must not trigger reconciler alerts).
await sql`update leads set is_test = true`.execute(db);
await sql`update operator_alerts set status = 'cancelled', locked_until = null where status in ('pending', 'retrying', 'sending')`.execute(db);

const worker = spawn(process.execPath, ["--import", "tsx", "src/workers/main.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LC_ALL: "en_US.UTF-8", APP_ENV: "test", LOG_LEVEL: "info",
    DATABASE_URL: url, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_load_test_key", RESEND_BASE_URL: fake.url,
    EMAIL_FROM: "Load <alerts@mail.example.com>", OPERATOR_ALERT_EMAILS: "ops@example.com", ADMIN_BASE_URL: "https://admin.example.test",
  },
});
let log = "";
worker.stdout!.on("data", (c: Buffer) => (log += c));
worker.stderr!.on("data", (c: Buffer) => (log += c));
for (let i = 0; i < 400 && !log.includes("worker started"); i += 1) await new Promise((r) => setTimeout(r, 50));
if (!log.includes("worker started")) throw new Error(`worker did not start:\n${log}`);

try {
  const service = buildLeadService(db);
  const base = Date.now() % 100_000_000;
  let counter = 0;
  const submit = () => {
    counter += 1;
    return service.submit(command(validSubmission({}, base + counter)));
  };

  async function waitSent(leadIds: string[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from operator_alerts where lead_id = any(${leadIds}::uuid[]) and status = 'sent'`.execute(db);
      if (rows[0]!.n === leadIds.length) return;
      if (Date.now() > deadline) {
        const stuck = await sql`
          select l.status as lead_status, l.fraud_decision, a.kind, a.status as alert_status, a.attempt_count, a.last_error_code, a.next_attempt_at < now() as due
            from leads l left join operator_alerts a on a.lead_id = l.id
           where l.id = any(${leadIds}::uuid[]) and coalesce(a.status::text, 'none') <> 'sent'`.execute(db);
        console.error("not sent:", JSON.stringify(stuck.rows));
        throw new Error(`only ${rows[0]!.n}/${leadIds.length} alerts sent in ${timeoutMs} ms`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function report(label: string, leadIds: string[]) {
    const { rows } = await sql<{ ms: number }>`
      select (extract(epoch from (a.sent_at - l.created_at)) * 1000)::float8 as ms
        from operator_alerts a join leads l on l.id = a.lead_id
       where a.lead_id = any(${leadIds}::uuid[]) and a.kind = 'new_lead' order by ms`.execute(db);
    const v = rows.map((r) => r.ms);
    const q = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!.toFixed(0);
    console.log(`${label.padEnd(44)} n=${String(v.length).padStart(3)}  p50=${q(0.5).padStart(5)} ms  p95=${q(0.95).padStart(5)} ms  p99=${q(0.99).padStart(5)} ms  max=${v[v.length - 1]!.toFixed(0).padStart(5)} ms`);
  }

  console.log(`provider latency: ${latencyMs} ms (fake). Lead stored -> provider accepted (sent_at - created_at):`);

  // 1. Realistic arrivals: one lead every 2 s.
  const spaced: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    spaced.push((await submit()).leadId);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  await waitSent(spaced, 30_000);
  await report("one lead every 2 s", spaced);

  // 2. A busy minute: ten leads a second.
  const busy: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    busy.push((await submit()).leadId);
    await new Promise((r) => setTimeout(r, 100));
  }
  await waitSent(busy, 60_000);
  await report("ten leads a second for 10 s", busy);

  // 3. A burst: 300 leads at once (an ad spike, or a worker that was down and has just come back).
  const burstStart = performance.now();
  const burst = await Promise.all(Array.from({ length: 300 }, async () => (await submit()).leadId));
  await waitSent(burst, 120_000);
  await report("burst of 300 at once", burst);
  console.log(`burst drained in ${((performance.now() - burstStart) / 1000).toFixed(1)} s (${(300 / ((performance.now() - burstStart) / 1000)).toFixed(0)} alerts/s including creating the leads)`);

  console.log(`provider calls: ${fake.requests.length} for ${spaced.length + busy.length + burst.length} leads (distinct emails delivered: ${fake.delivered.length})`);
} finally {
  // Never leave a worker behind: an orphan would keep competing for alerts in later runs and corrupt them.
  worker.kill("SIGKILL");
}
await new Promise((r) => (worker.exitCode !== null ? r(null) : worker.on("exit", r)));
await fake.close();
await db.destroy();
