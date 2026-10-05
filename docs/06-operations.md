# Operations: observability, performance, testing, deployment

# 1. Observability

**Principle:** every lead must have a reconstructable lifecycle after an incident. The database already holds the story: `lead_events`
(what happened), `lead_status_history` (every transition with actor and request id), `lead_fraud_signals` (why it scored what it did),
`consent_records` (what was agreed), and from later stages `routing_runs` (why it went where it did), `notification_attempts` (every
send), `lead_assignment_status_history` and `audit_logs`. Logs are the *secondary* source, correlated by `requestId`. Logs carry ids,
codes and counts, never personal data (redaction is a tested seat belt).

## What to measure, and how

| Signal | Source | Alert (starting point) |
| --- | --- | --- |
| API latency p50/p95/p99 by route | `durationMs` in the `lead accepted` log line; Cloudflare analytics | p95 > 800 ms for 10 min: warn |
| Form conversion rate (visit -> step n -> submit) | Cloudflare/Google Ads for visits; leads from the DB; per-step funnel needs a first-party events endpoint (stage 9) | Zero leads for N hours in ad hours: warn (ads disapproved, tracking broken, site down) |
| Lead submission rate | `select date_trunc('hour', created_at), count(*) from leads` | as above |
| Routing failures | `leads.status = 'unroutable'` count and age; `routing_runs.outcome` | Any `unroutable` older than 10 min: page during business hours |
| Lead stuck | `leads.status = 'new'` older than 60 s with no alert (stage 2: reported by `/api/pipeline` as `leads_unalerted` after 150 s; the reconciler alerts at 60 s) | **Page** |
| Alerting pipeline (stage 2) | `GET /api/pipeline`: `worker_stale` (no heartbeat for 90 s), `alerts_overdue` (due for 2 min, not sent), `alerts_dead` (retries exhausted for a lead nobody has handled), `leads_unalerted` | Any `degraded`: **page**. Point a monitor at it with a keyword check on `"status":"ok"` |
| Alert latency (stage 2) | `lead accepted` and `operator alert sent` log lines (`leadToAlertMs`), or `operator_alerts.sent_at - leads.created_at` | p95 > 10 s: warn |
| Held queue (stage 2) | Inbox "Needs action" count, oldest first on the page; one reminder email at 15 min | Held older than 4 h: ticket |
| Notification failures / dead letters | `notifications.status in ('failed','dead')` | `dead` > 0: ticket; delivery pending > 2 min: warn, > 5 min: page |
| Webhook failures per client | `client_integrations.consecutive_failures`, attempts by status | Integration `failing`: notify the client and ops |
| Queue latency | `now() - next_attempt_at` for due rows; `created_at -> sent_at` | p95 > 3 s: warn |
| Database | `pg_stat_statements`, connection count, disk, replication/backup age | Connections > 80%, disk > 80%, last backup > 26 h: page |
| Fraud rejection and hold rate | `fraud_decision` distribution; held queue size and age | Held queue older than 4 h: ticket; rejection rate doubling: investigate |
| Duplicate rate | `status = 'duplicate'` share | Sudden jump: possible double-submit bug or abuse |
| Error rate | 5xx share; Sentry | > 1% for 5 min: **page** |
| Client delivery rate | `delivered / assigned` per client | < 95% over a day: investigate |
| Money integrity | `wallet.balance <> sum(ledger)` nightly | **Page** |
| Our own failure of the bot check | Log `turnstile verification unavailable: failing open` count | Any burst: check Cloudflare status and our keys |

## Tools (cost-conscious)

- **Logs:** JSON to stdout -> platform logs, shipped to Better Stack or Axiom (generous free tiers) once there is a worker. `npm run dev:pretty` locally.
- **Errors:** Sentry (free tier), **built in stage 2** (`src/lib/error-reporting.ts`, decision D18). The SDK's v11 `dataCollection` options are all switched off (v11 replaced `sendDefaultPii`, and its defaults collect bodies, cookies, headers and local variables), no auto-instrumentation runs, and every event is scrubbed again (emails, UK phone numbers and postcodes masked) before it leaves. Every `logger.error` also reaches Sentry with a whitelist of ids and codes only. Verified with a capturing transport; **never exercised against a live Sentry project.**
- **Uptime and the canary:** an external check on `/api/ready` every minute, and from stage 5 a **canary lead** every 5 minutes (flagged `is_test`, routed to a test client, delivered to a test endpoint) that alerts if the full pipeline exceeds its budget. This catches the failures no unit test can: expired provider credentials, a stuck worker, a broken deploy.
- **Dashboards:** SQL-first. Metabase or Grafana on a **read-only database role** over the tables above, before any bespoke analytics UI.
- **Real-user performance:** `useReportWebVitals` posting to a first-party endpoint (stage 9), plus Search Console / CrUX once traffic exists.
- **Alert routing:** email/Slack for warnings, an on-call tool (Better Stack, PagerDuty) for pages. One person on call is enough initially; the paging list above is short on purpose.
- **OpenTelemetry:** deferred; Next.js supports it and `requestId` already provides correlation.

---

# 2. Performance targets and what was actually measured

Claims are cheap; these are measurements from this repository, and the method to repeat them. Lab numbers on a developer laptop are
**evidence of headroom, not of production performance**: production adds network round trips, TLS, the edge and a loaded database.

| Target | Measured | How | Verdict |
| --- | --- | --- | --- |
| Landing page < 2 s where achievable | Lighthouse **mobile** (simulated slow 4G, 4x CPU slowdown, the harsh default profile): **Performance 98**, Accessibility 100, Best Practices 96; FCP 0.8 s, **LCP 2.3 s**, TBT 10 ms, CLS 0, Speed Index 0.8 s. About 174 KB of JavaScript (gzip): React + Next ~115 KB, validation and form ~60 KB. `experimental.inlineCss` improved LCP 2.5 -> 2.3 s and Speed Index 1.4 -> 0.8 s. (SEO scores 66 in dev only because the dev build sends `noindex`.) | `npx lighthouse http://localhost:3100 --only-categories=performance` against `next build && next start` | Meets the intent; LCP is just over 2 s in the *pessimistic* profile. Real devices on typical connections should be faster: confirm with field data after launch |
| Form interaction instant | Step changes, tile selection and validation are client-side; the only network call mid-form is the coverage check (350 ms debounce, then one indexed query) | Playwright e2e, manual | Yes |
| Lead API < 300 ms excluding notification | Full HTTP path locally **p50 40 ms / p95 46 ms** (including the real call to Cloudflare Turnstile, ~38 ms of it). Our own code (validation + 15 database round trips + commit) **p50 2.6 ms / p95 2.9 ms** sequentially; at concurrency 10: **~1,250 leads/s, p95 ~10 ms**; at 50: ~1,290 leads/s | `tests/load/ingest-http.mjs`, `tests/load/ingest-inprocess.mts` | Large margin. Add ~1 ms per database round trip for a networked database (~15 ms) plus the edge |
| Routing < 100 ms under normal load | Not built (stage 4) | Will be `routing_runs.duration_ms` p95 | Budget: ~10 indexed round trips, so ~20-40 ms expected |
| Operator alert: lead stored -> email accepted by the provider (stage 2), p95 < 10 s | **Our pipeline's own overhead:** p50 12 ms, p95 16 ms, p99 35 ms with a zero-latency provider; p50 266 ms, p95 271 ms with a 250 ms provider; one lead every 2 s. Ten leads a second for 10 s with a 250 ms provider: p95 516 ms. **Burst of 300 leads at the same instant** with a 250 ms provider: p50 8 s, **p95 15 s**, drained at about 18 alerts/s (5 sends at a time). | `tests/load/alert-latency.mts`: the REAL worker process, a real PostgreSQL, a fake HTTP provider with the response latency you set. Real provider latency, network distance and a loaded database are NOT in these numbers | Meets the objective with large margin **at any realistic volume** (a single lead takes our overhead + the provider's own latency, typically a few hundred ms). The burst figure is a capacity limit, not a target: it is two orders of magnitude above real volume, and the knobs are the batch size in `src/workers/main.ts` and your provider's rate limit. **Resend's default is 10 requests per second per team**, so a burst this size would also meet HTTP 429s (retried with backoff, so nothing is lost, but the tail is slower than measured here against a fake with no limit). Re-measure with the provider's real latency from staging |
| Notification initiation within seconds (client delivery) | Not built (stage 5) | Define as `assignment.created_at -> first attempt started_at` p95 < 3 s; end to end "SMS on the roofer's phone" is dominated by the carrier (typically 1-10 s) and is measured with delivery callbacks | n/a |
| No lost leads | Atomic commit (lead + consent + audit + **operator alert row**) before the response; replay-safe retries; the alert reconciler (stage 2) and the canary (stage 5) | Reconciliation: accepted API responses (logs) vs rows in `leads`; `/api/pipeline`; canary | Stage 2: proven by killing a real worker mid-send (`tests/integration/worker-process.test.ts`); **not yet observed in production** |
| No duplicate assignments | Database-enforced; 12-way and 10-way races pass | `tests/integration/target-schema.test.ts` | Proven at the database level |

**Why the lead API is not the bottleneck:** 100,000 leads a month is ~2.3 per minute. Our path sustains ~1,250 per *second*, five orders of
magnitude more. The first real constraints, in order of likelihood:

1. **The Turnstile call.** It is the largest share of request latency, and with Cloudflare's *test* key it throttled to ~26-58 calls/s from
   one machine during testing, which capped the HTTP load test far below our own capacity. Confirm production-key limits with Cloudflare;
   the fail-open path exists for outages, not for load.
2. **Provider throughput and cost** (Twilio sender throughput, per-number limits, WhatsApp template quality, SMS spend).
3. **Recovery thundering herd:** after a provider outage the retry backlog all wakes at once. Cap per-provider concurrency in the worker.
4. **Database connections** if web instances multiply: PgBouncer (transaction mode) for web only; the worker connects directly because of `LISTEN`.
5. **Table growth:** `lead_events`, `lead_status_history`, `audit_logs`, `notification_attempts` are append-only: partition by month before they reach tens of millions of rows.
6. **Hot rows:** many leads per second for the same client serialise on that client's row (milliseconds each); only visible at levels this business will celebrate.
7. **Analytics queries on the primary:** move to a read replica when dashboards slow ingestion.
8. **The in-process rate limiter** is per instance (acceptable: the shared limits are at the edge and in the database).

---

# 3. Testing strategy

Built and passing today: **1,052 tests** (unit, component and integration against real PostgreSQL, including the target-schema race tests, the stage-2 worker, alert, inbox and access tests, the stage-3 clients, coverage, pricing, assignment and privacy tests, the stage-4 router tests, and the stage-5 delivery, webhook, SSRF, Twilio-callback and real-worker-process tests) and **109 end-to-end
checks plus 1 skipped by design** (phone + desktop Chrome; axe WCAG 2.2 AA on every consumer step, the inbox and every stage-3 and stage-4 page). Run `npm run check` then `npm run test:e2e`.

| Scenario (from the brief) | Layer | Status |
| --- | --- | --- |
| Validation (postcode, phone, email, name, consent, scope) | Unit | **Built**, 100+ cases including real libphonenumber behaviour |
| Fraud scoring and thresholds | Unit | **Built**: boundaries, calibration principles, every signal |
| Lead state transitions | Integration (DB triggers) | **Built**: legal paths, illegal pairs, history, actor context |
| Routing logic | Unit + integration | **Built (stage 4)**: the pure decision (every filter, limiter and ranker, with 2,000 generated situations and a fairness simulation), the router against a real database (switch, eligibility of leads, price, caps, hours in summer, winter and across the UTC day boundary, pauses, previously-held, take-backs, parking, retry, rules as data), and the eligibility query across every rule kind |
| Many workers, few businesses; a worker that dies; a person acting at the same moment | Integration, 6 workers with their own connection pools; a real connection killed mid-transaction; a real worker process SIGKILLed while blocked | **Built (stage 4)**: 90 leads over 6 workers never exceed a cap and share equal businesses to within one lead; a killed router leaves the lead untouched; assigning by hand or withdrawing consent at the same moment never produces two holders or a withdrawn lead held. Mutation-checked: 49 mutants killed; the 2 that survived are an equivalent redundancy and a no-op |
| "Who would get this lead?" agrees with what routing does | Integration, 6 generated worlds x 30 leads | **Built (stage 4)** |
| Pricing (flat rules, most specific wins, history immutable, concurrent changes to one scope) | Unit + integration | **Built (stage 3)**; the charge path itself is stage 6 |
| Database (constraints, grants, immutability, least privilege) | Integration | **Built** (tests run as the restricted role) |
| Postcode routing / coverage | Integration | **Built** (coverage service, handler, importer; eligibility query) |
| Notification providers | Contract tests with recorded fixtures + provider sandboxes (Twilio test credentials) | **Built against fakes (stage 5)**: a fake Twilio and a webhook receiver in `tests/helpers/fake-delivery.ts` follow the providers' documented behaviour and Twilio's published signature example. **Not run against real Twilio** |
| Webhooks (outbound signing; inbound signature + replay) | Integration with a local receiver | Stage 5 |
| Complete consumer journey | E2E | **Built** (real Chrome, phone and desktop) |
| Successful lead assignment | E2E + integration | **Built for manual assignment (stage 3)**: assign, send, take back, move, with the audit trail; automatic assignment is stage 4 |
| Double-sale races (assign vs assign, assign vs cancel vs reassign), cap-within-consent, consent withdrawn mid-assignment | Integration, concurrent, restricted role | **Built (stage 3)**; mutation-checked (see the note below on the two surviving mutants) |
| Privacy: erase, withdraw, suppression, replay after restore, nothing personal in audit or logs | Integration + e2e as owner and as staff | **Built (stage 3)** |
| Failed notification -> retry -> dead letter | Integration with a fake provider; fault injection | Stage 5 for client notifications. **Built for operator alerts (stage 2):** retry schedule, permanent failure, exhaustion after 8 attempts, timeouts, a thrown sender |
| Worker killed mid-send; duplicate delivery; frozen worker waking late | Real worker process + real HTTP adapter + fake provider; lease and compare-and-set tests | **Built (stage 2)**; each guarantee was mutation-checked (the protection removed, a test fails) |
| Operator access control: forged, expired, wrong-audience, wrong-issuer, unsigned, algorithm-confusion and service tokens; non-allowlisted email; spoofed headers | Unit (real key pairs, real HTTP key endpoint) + e2e in Chrome with a mock Access key server | **Built (stage 2)**; key rotation and an unreachable key endpoint included |
| No personal data in alert emails, alert tables, worker logs, error reports | Integration with a distinctive contact; scrubber unit tests with the real Sentry SDK and a capturing transport | **Built (stage 2)** |
| Duplicate submission (same key, same job different key) | Integration + E2E | **Built** (12 concurrent same-key; 8 concurrent same-job) |
| Fraud submission | Integration + E2E | **Built** (honeypot, machine-speed hold, automation UA) |
| No eligible client | Integration + e2e | **Built (stage 4)**: parked as `unroutable`, announced once, retried on change or after five minutes, can be handed over by hand |
| Concurrent submissions | Integration | **Built** at service level; HTTP level via the load tool |
| Accessibility and keyboard behaviour | E2E + component | **Built** |
| Dropped connection, retry, double-click, server down | E2E | **Built** |

Two kinds of test deserve emphasis because they found real defects: **mutation checks** (temporarily remove the lock/index and confirm
the race test fails: done for the identity lock, the exclusivity index and the shared-cap lock, and in stage 3 for the client, assignment, pricing and privacy protections; two mutants survived because the database enforces the same rule a second time, so they are equivalent, not untested) and **running as the restricted
database role** (a missing grant fails a test, not production).

## Load testing (how to do it properly)

1. **Environment:** a staging copy with production-like Postgres size and network; Turnstile test keys; unique synthetic contacts; `is_test`
   so billing and analytics ignore it. Never against production data.
2. **Shapes:** baseline (concurrency 1) for the latency floor; **open-model ramp** (arrival rate 1 -> 20/s) to find the knee; **spike** (0 -> 10x
   in 10 s: an ad burst); **soak** (1 h at 2x expected peak) watching memory, connections and table bloat.
3. **Fault injection while under load:** kill a database connection, slow or fail the provider (toxiproxy), kill the worker mid-job, restart
   a web instance, fill the retry backlog.
4. **Correctness after load, not just speed:** no duplicate assignments, `count(leads) = count(201 responses)`, wallet = ledger, no
   notification stuck in `sending`.
5. **Tooling:** k6 (or Artillery) for realistic runs; the two scripts in `tests/load/` are the quick local variants and refuse to run
   against anything that is not clearly a throwaway.

---

# 4. Deployment and DevOps

## Environments

| | Development | Staging | Production |
| --- | --- | --- | --- |
| Where | Laptop, local Postgres (`npm run db:local` or Docker) | Same platform, own project/database | Same platform, own project/database |
| Data | Synthetic postcodes (`--dev-postcodes`) | Real ONSPD subset, synthetic leads | Real ONSPD, real leads |
| Turnstile | Cloudflare test keys | **Real keys** (test keys refused) | Real keys |
| Indexing | `noindex` | `noindex` + HTTP auth or Access | Indexable |
| `APP_ENV` | `development` | `staging` | `production` (strictest checks) |
| Provider accounts | Sandbox/none | Sandbox | Live |

## Configuration and secrets

Every variable is documented in `.env.example` and validated at startup (`src/lib/env.ts`): the server refuses to start with bad
configuration, and in staging/production additionally refuses Cloudflare test keys, non-https `APP_URL`, `TRUST_PROXY=cloudflare` without an
origin secret and (production) placeholder legal details or `LEGAL_TEXT_REVIEWED=false`. Secrets live in the platform's secret store, never in
the repository; rotate by changing the value and redeploying (document each secret's owner and rotation in the runbook).
**Static pages bake `APP_URL`, brand and the Turnstile site key at build time:** changing them requires a rebuild.

## Database migrations and rollbacks

- **Roll-forward only** (`db/migrations/*.sql`, no down migrations), applied by `npm run db:migrate` as a **release command before the new
  version receives traffic**, in one transaction under an advisory lock (concurrent deploys cannot collide), then `npm run db:seed` (idempotent).
- **Expand/contract:** a migration must be compatible with the *previous* application version (add a nullable column, deploy, backfill, then
  enforce). That makes an application rollback safe: redeploy the previous build; never "down-migrate".
- Roles: migrations and seeds use the **owner** (`DATABASE_MIGRATION_URL`); the app uses **`leadgen_app`** (`db/roles.sql`); each migration grants
  explicitly. CI checks that generated types match the migrated schema.
- **Backups:** platform volume snapshots **plus** a nightly `pg_dump` to off-platform object storage (Cloudflare R2/S3) with a retention policy and a
  **monthly restore drill** into a scratch database. An untested backup is not a backup. Move to managed point-in-time recovery around
  1,000 leads/month or the first client SLA. After any restore, **re-apply the erasure/suppression log** (see 04): `npm run ops:replay-erasures` reads the retained `privacy: lead erased` log lines (lead ids only) and blanks those leads again. **`PRIVACY_HASH_KEY` must be backed up separately from the database and never rotated**: the suppression list is keyed HMACs, and without the key it can neither be matched nor rebuilt.
  **Built in stage 2:** `scripts/backup.sh` (custom-format dump, archive verified readable, checksum, `age` encryption required unless explicitly waived, copy to a directory or S3-compatible storage) and
  `scripts/restore-drill.sh` (restore into a scratch database, compare row counts with the live source, check every lead still has consent and contact details). **Rehearsed locally** against the development database (91 leads, 8 tables compared, all equal;
  restore took under a second at that size; re-run after stage 3 with 48 clients, 34 assignments, 285 audit rows and 28 suppressions, every table equal, plus checks that no assigned lead lacks a holder and no exclusive lead is held twice): a truncated dump and a drifted source each make the drill fail. **Not run:** the `age` encryption and the R2 upload (neither tool was installed here), and any run in the real environment. The dump
  contains personal data: it is encrypted to a public key whose private half is kept off the platform, and the script refuses to write an unencrypted one without an explicit override.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`): `npm ci` -> lint (including architecture rules) -> typecheck -> migrate and seed a Postgres 17 service -> generated-types
drift check -> unit/component/integration tests -> production build -> Playwright e2e (traces uploaded on failure). Deploy `main` after green CI
(Railway's GitHub integration with "wait for CI"). Optional preview environments per PR once there is a second developer. Action versions are
pinned to majors known to work: refresh via Dependabot.

## Edge, DNS, TLS, CDN, WAF, rate limiting

- **DNS/TLS:** domain on Cloudflare, proxied; SSL mode **Full (strict)** with an origin certificate; HSTS (the app sends it in production); redirect http -> https.
- **CDN:** cache `/` and `/_next/static/*` (the page is static, `s-maxage` set); **bypass `/api/*`** (the app sends `no-store`); purge on deploy.
- **WAF:** managed rules on; a rate-limit rule on `/api/v1/leads` and `/api/v1/postcodes/check` (free tier allows one: put it on the leads route);
  bot fight mode; country challenge only if abuse requires.
- **Lock the origin:** add a Cloudflare Transform Rule that sets `X-Origin-Verify: <secret>` on every request, set `TRUST_PROXY=cloudflare` and
  `ORIGIN_SHARED_SECRET` in the app. Anyone bypassing Cloudflare then cannot forge their IP or country. Disable or ignore the platform's raw
  hostname for the app where possible.
- **Turnstile:** create real keys bound to your hostnames; widget mode managed/invisible.
- **Admin:** separate subdomain under Cloudflare Access.

## Introduce now vs later (cost-conscious)

| Now (stage 1-2) | Later |
| --- | --- |
| Railway (web, later worker, Postgres) · Cloudflare free · Turnstile · GitHub Actions · Sentry free · uptime check · nightly dumps to R2 | Worker (stage 2) · email provider (stage 2) · log shipping (stage 2-3) · Twilio (stage 5) · Stripe (stage 6) |
| | Managed PITR Postgres (>= ~1k leads/mo or first SLA) · RUM (stage 9) · PgBouncer + replicas (~10k/mo) · Cloudflare Pro, on-call tool, warehouse (~100k/mo) |

## Launch checklist (before any real traffic)

- [ ] Real `BRAND_*` details (company name/number/address, ICO registration, privacy email); the footer and privacy notice show them.
- [ ] Consent wording, privacy notice and terms reviewed by a UK data-protection solicitor; `LEGAL_TEXT_REVIEWED=true`. DPIA considered; ICO fee paid.
- [ ] Client contract includes the controller-to-controller data clauses (use limits, deletion, breach notice, no onward sharing).
- [ ] Real Turnstile keys; `APP_ENV=production`; `APP_URL` https; build done with the production environment.
- [ ] `db/roles.sql` run; the app connects as `leadgen_app`; migrations as the owner; database not publicly reachable; `DATABASE_SSL` set appropriately.
- [ ] ONSPD imported (`/api/ready` green); footprint (`db/seeds/service-areas.ts`) matches where paying roofers operate.
- [ ] Cloudflare in front; origin lock configured; WAF/rate rule on; caching rules set; HSTS verified.
- [ ] Backups running **and one restore performed**; erasure/suppression replay documented.
- [ ] Error tracking with PII scrubbing (built; needs a Sentry project and `SENTRY_DSN`); uptime monitors on `/api/ready` **and `/api/pipeline`** (keyword `"status":"ok"`); alerts reach a human.
- [ ] Stage 2 live (code built and tested; needs deployment): worker running, Resend sending from a verified domain (SPF, DKIM, DMARC), Cloudflare Access in front of the admin host, `ADMIN_ALLOWED_EMAILS` set, and the **first-run verification in `docs/runbook.md` done** so no lead sits unseen; a named person owns responding within minutes.
- [ ] A restore drill from the real backup location (R2, encrypted) performed once, and scheduled monthly.
- [ ] Ad accounts: conversion tracking on the success state, UTM templates (02), consent platform if tags are added, ad copy states you are an introduction service.
- [ ] Run `npm run check`, `npm run build`, `npm run test:e2e` on the release commit.
