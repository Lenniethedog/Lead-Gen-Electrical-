// How long from "lead stored" to "assigned to a business", measured on the REAL worker process(es) against a real PostgreSQL.
//
//   LOAD_DATABASE_URL=postgres://postgres@127.0.0.1:54329/leadgen_load npx tsx tests/load/routing-latency.mts
//
// !! Writes hundreds of leads and clients. The database name MUST contain "load" (CREATE DATABASE leadgen_load TEMPLATE leadgen_dev):
// the script refuses anything else.
//
// Two different numbers, and they are not the same thing:
//   "decision"  = routing_runs.duration_ms: from the router taking the lock to commit (what the roadmap's < 100 ms target is about,
//                 and it includes waiting for the routing lock behind another lead being routed at that moment).
//   "end to end" = assignment.created_at - lead.created_at: what the business waits, including how soon the worker noticed the lead.
// What it does NOT measure: network distance between worker and database, or a database under other load.
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import pino from "pino";
import { sql } from "kysely";
import { createDb } from "../../src/lib/db/client";
import { ROOFING } from "../../src/config/verticals/roofing";
import { createClientService } from "../../src/modules/clients";
import { ensureOperator } from "../../src/modules/inbox";
import { createPricingService } from "../../src/modules/pricing";
import { createPrivacyService } from "../../src/modules/privacy";
import { createRoutingService } from "../../src/modules/routing";
import { startFakeResend } from "../helpers/fake-resend";
import { buildLeadService, command, validSubmission } from "../helpers/fixtures";

const url = process.env.LOAD_DATABASE_URL;
if (!url || !/\/[^/]*load[^/]*$/.test(new URL(url).pathname)) {
  console.error('Set LOAD_DATABASE_URL to a throw-away database whose name contains "load".');
  process.exit(2);
}
const root = path.resolve(import.meta.dirname, "../..");
const logger = pino({ level: "silent" });
const db = createDb({ url, poolMax: 10 });
const fake = await startFakeResend({ latencyMs: 0 });

// Leads copied from the template database are not part of the measurement.
await sql`update leads set is_test = true`.execute(db);
await sql`update operator_alerts set status = 'cancelled', locked_until = null where status in ('pending', 'retrying', 'sending')`.execute(db);

// --- A small world: three active businesses covering BR6, one with a daily cap, prices, and routing switched on -------------------
const owner = await ensureOperator(db, "load-owner@example.com", "owner");
const rid = () => crypto.randomUUID();
const clients = createClientService({ db, logger, verticalSlug: ROOFING.slug });
const pricing = createPricingService({ db, logger, verticalSlug: ROOFING.slug });
const privacy = createPrivacyService({ db, logger, hashKey: "load-test-privacy-hash-key-0123456789abcdef" });
const routing = createRoutingService({ db, logger, verticalSlug: ROOFING.slug, isSuppressed: privacy.isSuppressed });

await pricing.setPrice({ operator: owner, rule: { serviceSlug: null, serviceAreaSlug: null, urgency: null, saleType: "exclusive", pricePence: 3500 }, requestId: rid() });
const names = ["Load Roofing A", "Load Roofing B", "Load Roofing C"];
const ids: string[] = [];
for (const [index, name] of names.entries()) {
  const { id } = await clients.create({
    operator: owner,
    client: { name: `${name} ${Date.now()}`, contactEmail: `load${index}@roofer.example`, contactName: "Load", contactPhone: undefined, legalName: undefined, companyNumber: undefined, acceptsExclusive: true, acceptsShared: false, notes: undefined },
    requestId: rid(),
  });
  await clients.setServices({ operator: owner, clientId: id, serviceSlugs: ["roof_repair"], requestId: rid() });
  await clients.addRule({ operator: owner, clientId: id, rule: { mode: "include", kind: "outward", outward: "BR6" }, requestId: rid() });
  await clients.setStatus({ operator: owner, clientId: id, status: "active", requestId: rid() });
  ids.push(id);
}
const CAP = 120;
await sql`update clients set daily_lead_cap = ${CAP}, priority = 1 where id = ${ids[0]!}`.execute(db);
// The database was cloned from a development one that has other businesses covering BR6. Take them out of automatic routing (weight 0),
// so the load is decided between these three and the cap and fair-share checks below mean something. (Set LOAD_KEEP_OTHERS=1 to leave
// them in and measure a decision against a crowd of candidates instead.)
if (process.env.LOAD_KEEP_OTHERS !== "1") await sql`update clients set weight = 0 where id <> all(${ids}::uuid[])`.execute(db);
const { rows: candidatesNow } = await sql<{ n: number }>`select count(*)::int as n from clients where status = 'active' and weight > 0`.execute(db);
console.log(`${candidatesNow[0]!.n} businesses are in automatic routing for this run.`);
// Everything else is left at the defaults. Routing is switched on only now, so the leads created above this line are never touched.
await routing.setEnabled({ operator: owner, enabled: true, requestId: rid() });

function startWorker(): ChildProcess & { log: () => string } {
  let log = "";
  const child = spawn(process.execPath, ["--import", "tsx", "src/workers/main.ts"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", LC_ALL: "en_US.UTF-8", APP_ENV: "test", LOG_LEVEL: "info",
      DATABASE_URL: url!, EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_load_test_key", RESEND_BASE_URL: fake.url,
      EMAIL_FROM: "Load <alerts@mail.example.com>", OPERATOR_ALERT_EMAILS: "ops@example.com", ADMIN_BASE_URL: "https://admin.example.test",
      PRIVACY_HASH_KEY: "load-test-privacy-hash-key-0123456789abcdef",
    },
  });
  child.stdout!.on("data", (c: Buffer) => (log += c));
  child.stderr!.on("data", (c: Buffer) => (log += c));
  return Object.assign(child, { log: () => log });
}

const workers: Array<ChildProcess & { log: () => string }> = [];
async function ensureWorkers(count: number) {
  while (workers.length < count) workers.push(startWorker());
  for (const worker of workers) {
    for (let i = 0; i < 400 && !worker.log().includes("worker started"); i += 1) await new Promise((r) => setTimeout(r, 50));
    if (!worker.log().includes("worker started")) throw new Error(`worker did not start:\n${worker.log()}`);
  }
}

try {
  const service = buildLeadService(db);
  const base = Date.now() % 100_000_000;
  let counter = 0;
  const submit = () => {
    counter += 1;
    return service.submit(command(validSubmission({}, base + counter)));
  };

  async function waitRouted(leadIds: string[], timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await sql<{ n: number }>`select count(*)::int as n from leads where id = any(${leadIds}::uuid[]) and status = 'assigned'`.execute(db);
      if (rows[0]!.n === leadIds.length) return;
      if (Date.now() > deadline) throw new Error(`only ${rows[0]!.n}/${leadIds.length} leads assigned in ${timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  const quantiles = (v: number[]) => {
    const sorted = [...v].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: sorted[sorted.length - 1]! };
  };
  const fmt = (n: number) => n.toFixed(0).padStart(5);

  async function report(label: string, leadIds: string[]) {
    const { rows } = await sql<{ e2e: number; decision: number }>`
      select (extract(epoch from (a.created_at - l.created_at)) * 1000)::float8 as e2e, r.duration_ms::float8 as decision
        from leads l join lead_assignments a on a.lead_id = l.id join routing_runs r on r.id = a.routing_run_id
       where l.id = any(${leadIds}::uuid[])`.execute(db);
    const e = quantiles(rows.map((row) => row.e2e));
    const d = quantiles(rows.map((row) => row.decision));
    console.log(`${label.padEnd(36)} n=${String(rows.length).padStart(3)}  decision p50=${fmt(d.p50)} p95=${fmt(d.p95)} max=${fmt(d.max)} ms   end-to-end p50=${fmt(e.p50)} p95=${fmt(e.p95)} p99=${fmt(e.p99)} max=${fmt(e.max)} ms`);
  }

  const allLeads: string[] = [];
  console.log("Lead stored -> assigned to a business (real worker process(es), real PostgreSQL):");

  // 1. Realistic arrivals, one worker: one lead every 2 s.
  await ensureWorkers(1);
  const spaced: string[] = [];
  for (let i = 0; i < 25; i += 1) {
    spaced.push((await submit()).leadId);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  await waitRouted(spaced, 30_000);
  await report("1 worker, one lead every 2 s", spaced);
  allLeads.push(...spaced);

  // 2. A busy minute: ten leads a second.
  const busy: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    busy.push((await submit()).leadId);
    await new Promise((r) => setTimeout(r, 100));
  }
  await waitRouted(busy, 60_000);
  await report("1 worker, ten leads a second", busy);
  allLeads.push(...busy);

  // 3. A burst of 300 at once, one worker, then three workers (the routing lock serialises them: more workers cannot go faster).
  for (const count of [1, 3]) {
    await ensureWorkers(count);
    const started = performance.now();
    const burst = await Promise.all(Array.from({ length: 300 }, async () => (await submit()).leadId));
    await waitRouted(burst, 180_000);
    const seconds = (performance.now() - started) / 1000;
    await report(`${count} worker${count > 1 ? "s" : " "}, burst of 300 at once`, burst);
    console.log(`${" ".repeat(36)} drained in ${seconds.toFixed(1)} s (${(300 / seconds).toFixed(0)} leads/s including creating the leads)`);
    allLeads.push(...burst);
  }

  // Correctness after load, not just speed.
  const { rows: held } = await sql<{ client_id: string; n: number }>`
    select client_id, count(*)::int as n from lead_assignments where lead_id = any(${allLeads}::uuid[]) and status in ('reserved','notified','accepted','disputed') group by client_id order by n desc`.execute(db);
  const { rows: dup } = await sql<{ n: number }>`select count(*)::int as n from (select lead_id from lead_assignments where lead_id = any(${allLeads}::uuid[]) and status in ('reserved','notified','accepted','disputed') group by lead_id having count(*) > 1) d`.execute(db);
  const { rows: unrouted } = await sql<{ n: number }>`select count(*)::int as n from leads where id = any(${allLeads}::uuid[]) and status <> 'assigned'`.execute(db);
  console.log(`\nafter ${allLeads.length} leads: held per business ${held.map((row) => row.n).join(" / ")} (cap on the first: ${CAP}); leads held twice: ${dup[0]!.n}; leads not assigned: ${unrouted[0]!.n}`);
  const capped = held.find((row) => row.client_id === ids[0]!)?.n ?? 0;
  const others = ids.slice(1).map((id) => held.find((row) => row.client_id === id)?.n ?? 0);
  console.log(`first business (capped at ${CAP}): ${capped}; the other two: ${others.join(" and ")}`);
  const exactCap = process.env.LOAD_KEEP_OTHERS === "1" || capped === CAP;
  const fair = process.env.LOAD_KEEP_OTHERS === "1" || Math.abs(others[0]! - others[1]!) <= 1;
  if (capped > CAP || !exactCap || !fair || dup[0]!.n !== 0 || unrouted[0]!.n !== 0) throw new Error("CORRECTNESS FAILURE under load");
  const { rows: errs } = await sql<{ n: number }>`select count(*)::int as n from routing_runs where outcome = 'error'`.execute(db);
  console.log(`routing errors recorded: ${errs[0]!.n}`);
} finally {
  // Never leave a worker behind: an orphan would keep competing for work in later runs and corrupt them.
  for (const worker of workers) worker.kill("SIGKILL");
}
await Promise.all(workers.map((worker) => new Promise((r) => (worker.exitCode !== null ? r(null) : worker.on("exit", r)))));
await fake.close();
await db.destroy();
