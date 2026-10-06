<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Lead-generation platform: working agreements

Read `docs/README.md` first. These rules apply to every change.

**Priorities, in order:** reliability > simplicity > security > speed > scalability > cleverness. A lead that is lost,
sold twice or mishandled costs more than any feature earns. Prefer the boring option.

**Build in stages.** `docs/07-roadmap.md` defines the order. Do not build ahead (no billing before routing, no routing before
clients). Do not add Redis, a queue service, microservices or PostGIS until the triggers written in `docs/01-architecture.md`
are met: Postgres is the queue (transactional outbox) and the system of record.

**Architecture is enforced by lint.** `src/modules` is framework-free domain code and must not import `src/app`,
`src/components`, `src/server` or `next/*`. UI code must not import the database, repositories or Node built-ins.
All SQL lives in a module's `repo.ts` (or `db/`). Controllers (`src/server/handlers`) translate HTTP only.

**The backend is authoritative.** Shared Zod schemas live in `src/modules/*/schemas`; the browser uses them for instant
feedback, the server re-validates everything. Never duplicate a business rule in the UI. Use `import * as z from "zod"` (the
named form defeats tree-shaking and adds ~60 KB to the page).

**Database rules.**
- Migrations in `db/migrations` are roll-forward and **never edited once applied**; add a new one.
- After a schema change: `npm run db:migrate && npm run db:types` (CI fails on type drift).
- The app connects as the least-privilege role `leadgen_app`: every new table needs explicit grants in its migration.
- Integrity belongs in the database (constraints, partial unique indexes, triggers) as well as in code.
- Money is integer pence. Lead status changes only via UPDATE of `leads.status`; the trigger enforces legality and writes history.
- Multi-writer logic (assignment, credits, allowances) must be proven with a concurrent test, like `tests/integration/target-schema.test.ts`.
- Treat `40P01` (deadlock) and `40001` as retryable.

**Stage 2 rules (alerts, inbox, worker).**
- Every operator alert is written **in the lead's own transaction** (`enqueueOperatorAlert`). All queue SQL lives in `src/modules/alerts/repo.ts`; completions are compare-and-set on `(status, attempt_count)`.
  Race- and crash-prone changes need the same proof as before: a concurrent or real-process test, then **mutate the protection and watch a test fail**.
- Alert emails, alert tables, worker logs and error reports must carry **no contact details** (reference, service, outward postcode, urgency, screening result and a link only). `src/modules/alerts/message.ts` has no contact fields on purpose.
- The worker (`src/workers`, `npm run worker`) imports only framework-free code: no `next/*`, no `server-only`. It must tolerate being killed at any instant.
- Everything under `/admin` authenticates in `proxy.ts` **and again** in `src/server/admin` (`requireOperator`) because server actions are reachable by direct POST. Admin pages may import only the data-access layer in `@/server/admin` (`inbox`, `clients`, `pricing`, `assignments`).
  `src/server/admin/admin-guard.test.ts` fails if a page or action skips it. Decisions on held leads need a staff actor and a reason from the closed list in `src/config/review.ts` (the database refuses otherwise).
- Zsh does not word-split `$VAR`: pass file lists to test commands explicitly. Kill any worker you start by hand (`pkill -f src/workers/main.ts`): an orphan keeps competing for alerts in the next run.

**Stage 3 rules (clients, assignment, privacy).**
- **Never use the pool inside a transaction callback.** Resolve anything you need *before* `db.transaction().execute(...)`, or use the transaction handle: N concurrent callers against a pool of N otherwise deadlock (it happened; there is a regression test). Lock order is lead, then assignment, then client; pricing changes take an advisory lock per scope.
- Staff actions are **audited** (`writeAudit`, in the same transaction as the change) and every reason is a **code from a closed list** in `src/config/`, never free text: free text invites a consumer's details into the audit log. `writeAudit` refuses consumer fields.
- The database refuses what code must not do (one active exclusive holder, an assigned lead needs an assignment, consent caps the number of businesses, withdrawn consent cannot be assigned). Services check first and map a violation to a typed result (`mapGuardError`); do not delete a guard to make a test pass, change the test's setup.
- **Erasure is owner-only** and the service re-checks the role (a server action can be POSTed directly). Suppressions are keyed HMACs: `PRIVACY_HASH_KEY` must never be rotated. Never log a consumer's details; the one erasure log line carries the lead id only (it is what `ops:replay-erasures` reads after a restore).
- Admin pages call only the data-access layer in `src/server/admin`, and every exported function there starts with `requireOperator()`.
- Staff authenticate at Cloudflare Access, which is also where **MFA** is enforced; the app cannot check it. Do not add a second login system (decision D19).
- Modules should call each other only through `index.ts`; the lint rule for that is overdue (docs/01).

**Stage 4 rules (routing).**
- A lead is claimed, decided and assigned in **one transaction under one advisory lock** (`src/modules/routing`). Do not add a lease, a sweeper or per-client locks without reading decision D27; do not take a lead row lock from a trigger that fires inside a client edit (the router locks lead before client).
- The decision is pure (`engine.ts`) and the real router and the admin dry run both call `analyse`: a change to routing logic must keep `routing-explain.test.ts` (parity over generated worlds) green. Rule types are code; their parameters, order and on/off are data. A stored rule that does not validate **fails closed**.
- Routing is **off by default** and only routes leads that arrived while it was on. Anything that must always hold is NOT a rule (active, coverage, pause, weight 0, "gave it back", consent, suppression, a price).
- A database or network failure must never park a lead (`isInfrastructure`); an unexpected failure parks it for five minutes and writes an `error` run. Never retry a failing lead in a loop.
- "Needs a person" is one SQL fragment (`src/lib/db/lead-predicates.ts`) shared by the inbox, the reminder and the health check: change it there.
- The worker needs `PRIVACY_HASH_KEY` (the web service's own key) because the router checks suppressions.
- Modules reach each other only through `index.ts` (lint enforces it for `repo` and `service`; pure schema files may be imported by path for the browser).

**Stage 5 rules (delivery).**
- Notifications are created and cancelled by **triggers on `lead_assignments`** (migration 0006): do not enqueue from application code, and do not make `assignments` import `delivery` (cycle). The send re-checks the assignment, erasure and consent.
- A notification row, an attempt, a provider event, the audit trail and every log line hold **ids and error codes only**. A test dumps all of them with a distinctive contact: keep it green.
- Lock order is **lead, then assignment, then notification**. `settle()` is the one place that decides what a notification means for its assignment; it is idempotent and runs under the lead lock.
- Completions are compare-and-set on `(status = 'sending', attempt_count)`. Never start the next lease-protected call by awaiting a whole batch: the worker uses `pump()` (a bounded pool) so a hung business holds one slot.
- Outgoing webhooks go through `createWebhookSender` only (https, public addresses after DNS, connection pinned to the checked address, no redirects, capped response). Never `fetch` a business-supplied URL anywhere else. Webhook secrets are AES-256-GCM encrypted, shown once, never logged or audited; `DELIVERY_SECRETS_KEY` must not be rotated casually.
- The Twilio callback is public and verified by signature before anything is read from it; each (provider, event) is applied once. Never relax a check there "because it is only status updates".
- Provider adapters return a result for provider-level problems and never include the message in an error code.

**Stage 6 rules (client dashboard).**
- A business's people are `client_users` and sign in with an emailed one-time link (decision D43): no passwords, no library. The link opens a page with a **button**; only the POST spends it. Never make a GET sign anyone in, never log or store a token (only SHA-256 hashes are stored), never say whether an address has an account.
- **The dashboard reaches data only through `src/server/client`** (`portal.ts`, `signin.ts`, `session.ts`), whose every function authenticates first and takes the business from the verified session, never from the browser. `src/server/client/client-guard.test.ts` fails if a page skips this or imports the database.
- **Every dashboard query runs inside `withClientScope`** (`src/lib/db/client-scope.ts`) AND repeats `client_id = $1` in its own SQL. Row-level security on `lead_assignments`, `leads`, `lead_contacts` and `clients` returns only that business's rows when `app.client_id` is set, and changes nothing when it is not (staff, the worker, the router). A new table a business can read gets a policy in its migration and an entry in `client-tenancy.test.ts`. Do not add a policy that makes an unscoped path fail, and do not run business-scoped code as the table owner (RLS does not apply to it).
- A person's contact details are shown only while the business **holds** the lead (reserved, notified, accepted, disputed) and every reveal is audited (ids only). A lead we could not deliver is never shown to the business.
- **Money (D50-D54).** Never write `client_wallets`, `credit_ledger` or `lead_charges` from application code: the app role cannot. A charge and its refund are database triggers on `lead_assignments`, so any new way of creating or ending an assignment is already covered; do not add a second place that charges. Staff credit goes through `billing.post` (`post_credit()`); the form id is the idempotency key. Lock order ends with the wallet: take it last, and in the router use `lock_wallet_balance`. A new ending status for an assignment must be added to the reversal trigger's `WHEN` list in a new migration (and to `v_money_problems`). Reconciliation (`v_money_problems`) must stay empty: any change near money needs a concurrent test AND a mutation run, as in `tests/integration/billing.test.ts`.
- **Disputes (D55-D58).** Deciding a dispute goes through `disputes.decide` (lock order lead, assignment, dispute): never move a disputed assignment to `refunded` or `accepted` any other way. Everything staff choose is a code from `src/config/disputes.ts`; only the business's own words are free text, and they are cleared on erasure. An upheld dispute must leave the lead with routing stopped.
- **Account settings (D59-D62).** A business may write only the four columns in `updateNotificationState`; never widen it. Only an owner may change where leads are sent. Coverage and services are staff-only: the dashboard reads them and asks. Anything a business can read is in `client-tenancy.test.ts`'s list with a policy, and money or other business-only figures are withheld by the SERVICE for an agent, not just hidden in a page.
- Sessions are checked against the database on every request (person enabled, business allowed, not revoked, not idle, not past its end). Disabling a person or suspending a business ends access at once; keep that true.

**Privacy rules.** Never log or store personal data outside `lead_contacts` (and consent evidence). Event payloads, fraud
evidence and log lines carry ids, codes and counts only. Consent wording is versioned and immutable: bump `CONSENT_VERSION`,
never edit a published version. Do not add non-essential cookies or third-party scripts without a consent mechanism.

**Before you say it is done:** `npm run check` (needs `TEST_DATABASE_URL`, see README), and for UI/API changes
`npm run build && npm run test:e2e`. Report anything you could not run.

**Electrical rules (this is the electrical fork of the roofing platform: read UPSTREAM.md before porting a fix).**
- Never claim a business is registered, vetted, approved or accredited (NICEIC, NAPIT, "Part P", "competent person") until registrations are recorded and checked by us (decision E4). The site only tells consumers how to check.
- The emergency advice (`src/config/safety.ts`, `SafetyNote`) comes before the form, on the "when" question and in the FAQ (E3). Re-check the numbers and the wording on any copy change, and keep the one-line version short: on a phone the first question must stay on the first screen (an e2e test asserts it).
- Electrical decisions are numbered **E1-E5**, roofing's stay D1-D67 and boilers' B1-B5, so they never collide when a fix is ported. `src/config/no-roofing.test.ts` fails if roofing wording reaches the application.
- Own ports: web 3300, end-to-end 3310, key server 3399, PostgreSQL cluster 54349 (`npm run db:local`, database `electrical_dev`). Roofing, boilers and the CRM use others: never point this project at their databases.
- Never push to the `roofing` remote (it exists only to fetch fixes). `origin` is `Lenniethedog/Lead-Gen-Electrical-`.

**Local gotchas.** Port 3300 may be taken: run on another port and set `APP_URL` to match. Zsh does not word-split `$VAR`.
