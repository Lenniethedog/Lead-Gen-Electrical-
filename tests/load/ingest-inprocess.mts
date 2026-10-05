// Capacity of OUR code path: the real request handler + a real PostgreSQL, with the Turnstile call stubbed so
// Cloudflare is not part of the measurement.
//
//   LOAD_DATABASE_URL=postgres://postgres@127.0.0.1:54329/leadgen_load npx tsx tests/load/ingest-inprocess.mts
//
// !! Writes thousands of leads. The database name MUST contain "load" (create it from a migrated + seeded
// template: CREATE DATABASE leadgen_load TEMPLATE leadgen_dev) - the script refuses anything else.
import pino from "pino";
import { createDb } from "../../src/lib/db/client";
import { SlidingWindowRateLimiter } from "../../src/lib/rate-limit";
import { createLeadService } from "../../src/modules/leads";
import { createPostcodeService } from "../../src/modules/postcodes/service";
import { createReferenceDataProvider } from "../../src/modules/reference";
import { handleSubmitLead } from "../../src/server/handlers/submit-lead";

const url = process.env.LOAD_DATABASE_URL;
if (!url || !/\/[^/]*load[^/]*$/.test(new URL(url).pathname)) {
  console.error('Set LOAD_DATABASE_URL to a throw-away database whose name contains "load".');
  process.exit(2);
}

const db = createDb({ url, poolMax: 10, timeouts: { statementMs: 5000, lockMs: 3000, idleInTransactionMs: 10000 } });
const logger = pino({ level: "silent" });
const deps = {
  leadService: createLeadService({
    db, postcodes: createPostcodeService(db), reference: createReferenceDataProvider(db),
    challenge: { verify: async () => ({ status: "passed" as const }) }, logger, verticalSlug: "roofing",
  }),
  logger, ipConfig: { mode: "none" as const, trustedHops: 1 }, allowedOrigins: ["http://localhost:3000"],
  rateLimiter: new SlidingWindowRateLimiter({ limit: 1_000_000, windowMs: 60_000 }),
};
const services: Array<[string, string]> = [["roof_repair", "leak"], ["new_roof", "full_replacement"], ["flat_roof", "replace"], ["chimney", "leadwork"], ["guttering_fascias", "replace"], ["roof_inspection", "condition_survey"]];
const postcodes = ["BR6 0AA", "BR1 1AA", "TN13 1AA", "DA1 1AA", "BR5 1AA", "DA11 0AA"];
const base = Date.now() % 100_000_000;

function request(n: number): Request {
  const [service, scope] = services[n % services.length]!;
  return new Request("http://localhost:3000/api/v1/leads", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost:3000", "idempotency-key": crypto.randomUUID(), "user-agent": "Mozilla/5.0 (iPhone) Mobile/15E148" },
    body: JSON.stringify({
      service, postcode: postcodes[n % postcodes.length], propertyType: "house", ownership: "owner", scope, urgency: "within_2_weeks",
      contact: { name: "Load Tester", phone: `07123 ${String(n % 1_000_000).padStart(6, "0")}`, email: `inproc.${n}.${base}@example.com`, notes: "" },
      consent: { accepted: true, textVersion: "v1" },
      context: { elapsedMs: 45000, turnstileToken: "t", honeypot: "", pagePath: "/", attribution: { utmSource: "google", utmMedium: "cpc" } },
    }),
  });
}

async function run(total: number, concurrency: number, start: number) {
  let next = start;
  const latencies: number[] = [];
  const statuses: Record<number, number> = {};
  const t0 = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const n = next++;
      if (n >= start + total) return;
      const t = performance.now();
      const res = await handleSubmitLead(request(n), deps);
      await res.text();
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      latencies.push(performance.now() - t);
    }
  }));
  const seconds = (performance.now() - t0) / 1000;
  latencies.sort((a, b) => a - b);
  const q = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]!.toFixed(1);
  console.log(`concurrency=${String(concurrency).padStart(3)}  ${total} leads in ${seconds.toFixed(1)}s => ${(total / seconds).toFixed(0).padStart(4)} leads/s | p50=${q(0.5)}ms p95=${q(0.95)}ms p99=${q(0.99)}ms | ${JSON.stringify(statuses)}`);
}

await run(50, 2, 500000); // warm-up
await run(500, 1, 510000);
await run(2000, 10, 520000);
await run(2000, 50, 540000);
await db.destroy();
