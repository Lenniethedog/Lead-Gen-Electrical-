# Local lead-generation platform

Captures consumer enquiries for a local service niche, screens and stores them reliably, and (in later
stages) routes each one to the right local business and delivers it within seconds.

**Launch assumption (the brief had unfilled placeholders):** electricians and electrical contractors across South East London
(Bromley, Bexley and the nearest SE postcodes), North Kent and Sevenoaks. The niche and footprint are configuration, not architecture; see
[docs/00-assumptions-and-decisions.md](docs/00-assumptions-and-decisions.md).

## Status

| Stage | What | State |
| --- | --- | --- |
| **1** | **Lead capture**: landing page, six-step form, validated and idempotent ingestion API, postcode coverage, consent evidence, fraud screening, audit trail | **Built and tested** |
| **2** | **Operator alerts and inbox**: a worker process, an alert email per new/held lead (no contact details in it), a reminder, a reconciler that cannot lose a lead, a protected inbox to see and decide leads, health endpoint, error reporting, backups | **Built and tested locally**; not yet run against real Resend, Cloudflare Access, Sentry or Railway |
| **3** | **Clients, coverage and manual assignment**: client records, coverage rules and a coverage tester, flat pricing, hand a lead to a business and take it back or move it (with reasons and an audit trail), consent withdrawal and owner-only erasure with a keyed-hash suppression list | **Built and tested locally**; MFA is enforced at Cloudflare Access, which the app cannot check: see the runbook |
| **4** | **Automatic routing**: the router hands each new lead to one business by editable rules (priority, fair share, daily and monthly caps, working hours, pauses), records why, parks what nobody can take, and has a dry-run "who would get this lead?"; **off until an owner switches it on**; it assigns, a person still sends | **Built and tested locally**; built before Gate B (see docs/00, stage 4 decisions); not yet run against a real worker deployment |
| **5** | **Instant delivery**: tells a business about its lead the moment it is assigned, by email, text message and signed webhook, per business and off by default; retries, a bounded worker pool, a dead-letter queue ("Deliveries that need you"), Twilio delivery reports, and the lead is freed and re-routed if every way fails | **Built and tested locally** against stand-ins; **nothing has been sent through a real Twilio account, a real receiver or a real sending domain** |
| 6–10 | Client dashboard and credits, payments, admin, fraud v2, analytics, scale | Designed, not built: [docs/07-roadmap.md](docs/07-roadmap.md) |

Stage 2 is the point at which leads reach a human; stage 3 is the point at which you can record who received each one. Gate A (a small paid test with real electrical businesses) is a business test that only you can run. **Do not spend on ads until [docs/runbook.md](docs/runbook.md)'s first-run verification has passed** against the real services
(email delivery, the Access-protected inbox, the uptime monitors, a restore drill).

## Quick start

Requires Node 22.12+ and PostgreSQL 16+ (Docker, or PostgreSQL binaries on your PATH).

```bash
npm install
cp .env.example .env.local          # development defaults work as-is

# A database: either of these.
docker compose up -d db             # port 54349
npm run db:local                    # no Docker: isolated cluster in .local/ using Homebrew/apt Postgres

npm run db:setup                    # migrations + reference data (electrical, services, footprint, consent wording)
npm run db:seed -- --dev-postcodes  # SYNTHETIC postcodes so the form works before the real import (dev only)

npm run dev                         # http://localhost:3300
npm run worker                      # second terminal: sends operator alerts (printed to the terminal in development)
```

Open `http://localhost:3300/admin` for the operator inbox: in development it admits the operator named by `ADMIN_DEV_EMAIL` (no Cloudflare Access needed; never in a production build).

Port 3300 busy? `npm run dev -- -p 3301` **and** set `APP_URL=http://localhost:3301` (the API only accepts
browser requests from `APP_URL`/`ALLOWED_ORIGINS`).

### Real postcode data

Validation and coverage use the ONS Postcode Directory (Open Government Licence). Download the latest
"ONS Postcode Directory" from the ONS Open Geography Portal, unzip, then:

```bash
npm run postcodes:import -- path/to/ONSPD_AUG_2026_UK.csv --areas BR,DA,TN,SE --edition 2026-08
npm run postcodes:import -- path/to/ONSPD_AUG_2026_UK.csv --dry-run     # parse and count only
```

The importer is idempotent, never deletes, replaces the synthetic dev rows, and refuses files that are not
ONSPD. Refresh quarterly. `/api/ready` reports not-ready until postcodes are loaded.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` / `build` / `start` | Next.js (use `build` + `start` to measure production behaviour) |
| `npm run check` | lint + typecheck + all tests: run before finishing any change |
| `npm test` | Unit, component (jsdom) and integration tests; the integration project needs `TEST_DATABASE_URL` |
| `npm run test:unit` / `test:integration` | One layer at a time |
| `npm run test:e2e` | Playwright in real Chrome against a production build and the dev database |
| `npm run db:migrate` / `db:seed` / `db:setup` | Roll-forward migrations, idempotent reference data |
| `npm run db:demo` | Loads six fictional electrical businesses, prices and fourteen enquiries in every state into an **empty local** database (refuses anything else); run after `db:setup` and `db:seed -- --dev-postcodes` |
| `npm run db:types` / `db:types:check` | Regenerate / verify the Kysely types from the live schema (CI checks drift) |
| `npm run dev:pretty` | Dev server with readable JSON logs |
| `npm run worker` / `worker:dev` | The worker process (alert emails, the router, delivery to businesses, the reconciler); `worker:dev` restarts on change with readable logs |
| `npm run ops:email-smoke` / `ops:sentry-smoke` | Send one test email / one test error through the configured provider: first-run verification |
| `npm run ops:replay-erasures -- <logfile> [--apply]` | After a restore, re-apply the erasures recorded in the retained logs (report only without `--apply`) |
| `bash scripts/backup.sh` / `scripts/restore-drill.sh` | Encrypted logical backup; restore into a scratch database and compare with the source (see the runbook) |

## Testing

| Layer | Where | What it proves |
| --- | --- | --- |
| Unit | `src/**/*.test.ts` | Validation, phone/postcode rules, fraud scoring, IP trust, rate limiting, env guards, form state machine, API retry logic |
| Component | `src/**/*.test.tsx` (jsdom) | Accessible choice tiles (keyboard vs pointer), storage persistence edge cases |
| Integration | `tests/integration` | Real PostgreSQL, restricted app role: lifecycle triggers, append-only audit tables, least privilege, idempotency, **concurrent duplicate and double-submit races**, HTTP handlers, seeds, importer, the **target-schema race tests** (no double-sale, no over-share, no double-charge), for stage 5 the **delivery outbox** (retries, a frozen or killed worker, six workers at once, consent withdrawn mid-flight, Twilio reports and the signature check, the SSRF defences, secrets) and a **real worker process killed while a business's server hangs**, for stage 4 the **router** (rules, caps, hours, fair share, crash and race tests with many workers, a dry run that must agree with the real decision), for stage 3 the **double-sale and consent guards, concurrent assignment, pricing, coverage and privacy tests**, and for stage 2 the **alert outbox** (retry, dead letter, leases, compare-and-set, concurrent workers, the reconciler), the inbox races, the worker loop, and **a real worker process killed with SIGKILL mid-send** |
| End-to-end | `tests/e2e` | Real Chrome, phone and desktop: full journey, keyboard behaviour, dropped connection + retry (one lead), double-click, server errors, axe WCAG 2.2 AA on every step, and the operator inbox with **real signed Access tokens** (every refusal case, then approve/reject/handle, accessibility), and for stage 3 the whole manual-sale journey (create and activate a client, ask the coverage tester, set a price, assign, send, take back, move, withdraw, erase as an owner and not as staff) |

Integration tests create a throw-away database per file from a migrated template and connect as the
**restricted `leadgen_app` role**, so a missing grant fails a test instead of failing in production.

## Layout

```
src/app          Next.js routes only: pages and thin API controllers
src/components   UI (landing page, lead form, shared controls)
src/modules      domain logic, framework-free: leads, fraud, postcodes, consent, attribution, reference, alerts, inbox, clients, coverage, pricing, assignments, privacy, audit, routing, delivery
src/server       composition root + HTTP handlers (the controllers' logic); server/admin is the inbox's data-access layer
src/workers      the worker process (entrypoint, control loop, LISTEN connection)
src/integrations adapters behind interfaces (email: Resend and console; delivery: Twilio, signed webhooks)
src/proxy.ts     first gate for /admin (Cloudflare Access token + allowlist)
src/lib          foundations: env, db, http, logging, ip, rate limiting, ids, Access verification, error reporting
src/config       decisions as code: brand, vertical (electrical), consent wording, fraud weights, retention
db/migrations    SQL, roll-forward only        db/seeds   idempotent reference data
scripts          migrate, seed, types, ONSPD import, local Postgres
docs             architecture, data model, roadmap, security: start at docs/README.md
```

Dependency direction is enforced by ESLint (`npm run lint`): modules never import the web layer, UI never
imports the database (the admin pages may call only the data-access layer in `src/server/admin`, which authenticates every call).

## Configuration

Copy `.env.example`; every variable is documented there and validated at startup (the server refuses to
start with bad configuration). The web process and the worker each validate only their own settings. Production additionally refuses placeholder legal details, Cloudflare test
keys, `LEGAL_TEXT_REVIEWED=false`, a missing Cloudflare Access configuration, missing `ADMIN_OWNER_EMAILS` or `PRIVACY_HASH_KEY`, the console email provider and a missing `SENTRY_DSN`.

## Before any real traffic

Stand the system up with [docs/runbook.md](docs/runbook.md) and work through its first-run verification, then see the launch checklist in [docs/06-operations.md](docs/06-operations.md). The short version: real brand and legal
details, solicitor-reviewed consent wording and privacy notice, real Turnstile keys, least-privilege database
role, Cloudflare in front with the origin secret, ONSPD loaded, backups restored at least once.
