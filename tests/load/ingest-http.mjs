// HTTP load test for POST /api/v1/leads: unique, valid submissions at a fixed concurrency.
//
//   BASE=http://localhost:3101 TOTAL=500 CONCURRENCY=10 node tests/load/ingest-http.mjs
//
// !! This CREATES REAL LEADS in whatever database the target server uses. Point it only at a server running
// against a throw-away database (e.g. CREATE DATABASE leadgen_load TEMPLATE leadgen_dev), never at dev data,
// staging that people use, or production. With Cloudflare's test Turnstile key the verification call itself
// is rate-limited by Cloudflare (observed ~30-60 calls/s), which then dominates: that measures Cloudflare,
// not us. For OUR capacity use tests/load/ingest-inprocess.mts.
const BASE = process.env.BASE;
if (!BASE) {
  console.error("Set BASE (e.g. BASE=http://localhost:3101). See the warning at the top of this file.");
  process.exit(2);
}
if (!/localhost|127\.0\.0\.1/.test(BASE) && process.env.I_UNDERSTAND_THIS_CREATES_LEADS !== "yes") {
  console.error("Refusing to load-test a non-local target without I_UNDERSTAND_THIS_CREATES_LEADS=yes.");
  process.exit(2);
}
const TOTAL = Number(process.env.TOTAL ?? 300);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
const START = Number(process.env.START ?? Date.now() % 800000);
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const services = [["roof_repair", "leak"], ["new_roof", "full_replacement"], ["flat_roof", "replace"], ["chimney", "leadwork"], ["guttering_fascias", "replace"], ["roof_inspection", "condition_survey"]];
const postcodes = ["BR6 0AA", "BR1 1AA", "TN13 1AA", "DA1 1AA", "BR5 1AA", "DA11 0AA"];

const payload = (n) => {
  const [service, scope] = services[n % services.length];
  return {
    service, postcode: postcodes[n % postcodes.length], propertyType: "house", ownership: "owner", scope, urgency: "within_2_weeks",
    contact: { name: "Load Tester", phone: `07123 ${String(n % 1000000).padStart(6, "0")}`, email: `load.${n}.${START}@example.com`, notes: "" },
    consent: { accepted: true, textVersion: "v1" },
    context: { elapsedMs: 45000, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", honeypot: "", pagePath: "/", attribution: { utmSource: "google", utmMedium: "cpc" } },
  };
};

let next = START;
const latencies = [];
const statuses = {};
async function worker() {
  for (;;) {
    const n = next++;
    if (n >= START + TOTAL) return;
    const t0 = performance.now();
    try {
      const res = await fetch(`${BASE}/api/v1/leads`, { method: "POST", headers: { "content-type": "application/json", origin: BASE, "idempotency-key": crypto.randomUUID(), "user-agent": UA }, body: JSON.stringify(payload(n)) });
      await res.text();
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    } catch {
      statuses.network = (statuses.network ?? 0) + 1;
    }
    latencies.push(performance.now() - t0);
  }
}
const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const q = (p) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))].toFixed(0);
console.log(`concurrency=${CONCURRENCY} total=${latencies.length} in ${seconds.toFixed(1)}s => ${(latencies.length / seconds).toFixed(0)} req/s | p50=${q(0.5)}ms p95=${q(0.95)}ms p99=${q(0.99)}ms max=${latencies.at(-1).toFixed(0)}ms | status ${JSON.stringify(statuses)}`);
