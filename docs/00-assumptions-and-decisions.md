# Assumptions and decisions

## 1. Assumptions made

The brief's project parameters were template placeholders (`[e.g. ...]`). The brief says to assume sensibly and continue, so each
parameter took the first example, which also happens to be mutually consistent. Stage 2 was built on these assumptions (none of it depends on the niche or region),
but **confirm or correct them before go-live**: they decide the legal text, the footprint and who the first clients are.

| Parameter | Assumed | Cost of being wrong |
| --- | --- | --- |
| Niche | Roofing contractors (repairs, new roofs, flat roofs, chimneys, gutters/fascias, inspections) | Low. The vertical is one config file (`src/config/verticals/roofing.ts`), a seed and some landing copy. |
| Region | Orpington, Bromley, Sevenoaks, North Kent (`db/seeds/service-areas.ts`: BR1-8, DA1-4, DA9-13, TN13-15) | Low. Footprint is data. **The district list is my guess**; match it to where paying roofers actually work. |
| Stack | Next.js + TypeScript + PostgreSQL + Tailwind; Node worker process; no Redis | See decision D1. |
| Hosting | One container platform (Railway) behind Cloudflare | Moderate; the app is container-portable. See D2. |
| Channels | Email + SMS + webhook first, WhatsApp second | See D12. |
| Volume | 100 to 1,000 leads/month at launch, 10,000+ later | Capacity is not the constraint (section 5 of 06-operations). |
| Sale model | Exclusive: one business per lead | Shared leads are designed in (DB constraints exist) but not built. |
| Consumers | UK only; consent captured per lead | n/a |
| Brand | Working title "RoofQuote Local", all legal details placeholders | Production refuses to start until real details are set. |

## 2. Decisions that differ from the brief

The brief asked for objections where its choices are wrong. Each is an ADR-style record: decision, reason, and the trigger that
would change it.

**D1. No Redis or BullMQ yet; PostgreSQL is the queue (transactional outbox).**
The dangerous failure for this business is a lead saved in the database whose notification job was never enqueued (the dual write).
With a Redis queue you must close that gap with a reconciler. With the job row written in the same transaction as the lead, the gap
cannot exist. 1,000 leads a month is one every 43 minutes; 100,000 a month is one every 18 seconds on average. Postgres with
`FOR UPDATE SKIP LOCKED` (or `graphile-worker`) handles thousands of jobs per second. Redis would add a second stateful system to
secure, back up, monitor and pay for. *Revisit when:* sustained job throughput above ~100/s, or per-provider rate limiting
that needs queue-native features, or queue polling measurably hurts the primary database.

**D2. One platform for web, worker and database (Railway) behind Cloudflare; not Vercel + Railway.**
The part of the system that must never lose a lead needs a long-lived process next to the database: persistent connection pool,
`LISTEN/NOTIFY`, a worker, cron. Serverless functions add connection pooling hazards and a second vendor for no benefit at this
scale. Cloudflare in front gives CDN, WAF, rate limiting, Turnstile, DNS and TLS free. The static landing page is cacheable at the
edge. Vercel remains a fine home for the marketing site later if wanted. *Revisit when:* data residency or procurement demands UK
region and HA (then AWS `eu-west-2`: the app is already containerisable), or at ~10k leads/month for managed PITR Postgres.

**D3. Modular monolith. The "Node backend" is the same Next.js process plus a worker, not a separate API service.**
One repo, one deployable web process, one worker process (stage 2). Modules (`src/modules/*`) are framework-free and the boundaries
are enforced by lint, so any module can be extracted into a service later without rewriting it. Extracting before there is a
second team or a scaling reason is cost with no benefit.

**D4. No PostGIS yet.**
Routing matches by postcode district/sector and by radius from a base postcode. The *clients* are the small set (hundreds), not the
postcodes: a haversine check over a handful of radius rules is microseconds, and needs no spatial index. PostGIS earns its place for
drawn polygons (e.g. whole local-authority areas) or radius search over >100k service areas. It complicates local dev, CI and
managed-hosting choices today for zero gain. The schema keeps `lat/lng` on `postcodes`, so adding PostGIS later is one migration.

**D5. The brief's single status list is split into three state machines.**
`delivered`, `accepted`, `disputed`, `refunded` describe a *client's relationship to a lead*, not the lead. A flat list cannot
express "shared lead: client A accepted, client B disputed". So: **lead** status (the enquiry's processing), **assignment** status
(one client's hold on it) and **notification** status (one delivery attempt series). 02-data-model.md maps your names onto them.

**D6. Roadmap order differs from the example.**
Form and ingestion are one stage (a form that stores nothing cannot be tested or demonstrated). Baseline fraud controls ship in
stage 1 (paid traffic attracts bots from the first click). A minimal operator inbox comes before routing, so the first leads can be
sold by hand. Clients come before routing (routing needs them). Billing waits for a paying client.

**D7. Exclusive first.** Roofers resent shared leads (price race, low close rates), and exclusivity is the simplest model to make
correct. The database already supports shared leads with a hard cap; enable them deliberately later.

**D8. Personal data is isolated.** Everything personal about a consumer lives in `lead_contacts` (plus the IP and user agent held as
consent evidence). Erasure is one constrained operation; analytics and routing run on non-personal columns; event payloads and
fraud evidence are contractually free of personal data (and tested).

**D9. Consent wording is a versioned, immutable legal artefact tied to commercial behaviour.** It states how many businesses may
receive the details. The router must never exceed that number. Wording can only change by publishing a new version; the database and
`/api/ready` refuse to run if code and archive disagree.

**D10. Bot challenge fails open with a penalty, and a missing token means "hold for review", not "reject".**
A verification outage or a privacy extension blocking the script must not cost a real lead. Strong signals (honeypot, blocklist)
reject; suspicious-but-uncertain submissions are *held* for a human, so a false positive is recoverable.

**D11. Bots receive a success-looking response.** The API answers identically whether a lead was accepted, held, deduplicated or
rejected as spam, so the response teaches an attacker nothing about screening. A duplicate gets the *original* reference.

**D12. SMS and email before WhatsApp.** WhatsApp Business needs Meta business verification, approved message templates and
recipient opt-in, with days of lead time and per-message pricing. SMS plus email plus signed webhooks cover launch; add WhatsApp when
a client asks and the paperwork is done.

**D13. CSP without nonces, to keep the landing page static.** Nonce-based CSP forces dynamic rendering and defeats CDN caching
(Next.js docs say so). The policy allows only self and Cloudflare Turnstile; inline scripts are permitted because there is no
user-generated HTML. Revisit if third-party tags (ads, analytics) are added: then use a consent platform and re-evaluate.

### Stage 2 decisions

**D14. The alert queue is a Postgres outbox table (`operator_alerts`), not `graphile-worker`. This deviates from the roadmap text, which planned graphile-worker for stage 2.**
The guarantee the acceptance criteria demand is "kill the worker mid-send and the alert is still delivered exactly once or retried, never lost". `graphile-worker` recovers a job
locked by a crashed worker only after a long stale-lock timeout (its documentation says a job locked by a crashed worker stays locked for 4 hours by default: [Graphile Worker docs](https://worker.graphile.org/docs/pro/recovery), checked 2026-10-05), so to meet that criterion we would have needed our own state (the alert row, a lease, a
reconciler) *anyway*; graphile would then be a second queue sitting beside the real one, plus a second migration system and its own schema and privileges. The outbox row is both the work item and the
audit record (as 03-routing-and-delivery.md already designed for notifications): created in the lead's own transaction, claimed with `FOR UPDATE SKIP LOCKED` under a 60 s lease, retried with
backoff, reclaimed by a reconciler when its worker disappears, and finished with compare-and-set so a frozen worker cannot overwrite a newer state. All of the queue's SQL is in one file
(`src/modules/alerts/repo.ts`); that file is the swap point for SQS/BullMQ, not a `src/workers/queue.ts` interface (there is one implementation, so an interface would be speculative).
Scheduled work in stage 2 is one idempotent reconciler tick (`setInterval`, safe from any number of workers). *Revisit (adopt graphile-worker, or a cron library)* when there are three or more
kinds of scheduled job needing cron expressions and per-job retry policy (stage 8: retention, exports, reports), or when job throughput needs a different shape than "one row per message".

**D15. Alert emails carry no contact details.** Email is not a secure channel and a mailbox is a long-lived copy. An alert contains the reference, service, outward postcode, urgency, the screening
result and a link; the consumer's name, phone, email and notes live only on the protected page. The message input type has no contact fields, the query that fills it never reads `lead_contacts`,
and `tests/integration/alerts-service.test.ts` proves with a distinctive contact that nothing leaks into the email, the alert tables or the logs. The cost is one tap and a sign-in on a phone before the operator sees
the number. *Revisit if* operators measurably lose time to it; the likely answer is a longer Access session, not more data in the email.

**D16. The inbox is protected by Cloudflare Access with the token verified in the app, an email allowlist, and a re-check in the data layer.** Cloudflare Access alone would leave the inbox open to anyone who finds the origin URL
or to a too-broad Access policy. The app verifies the `Cf-Access-Jwt-Assertion` JWT (RS256 only; issuer, audience, expiry required; an email claim required, so service tokens are refused; keys fetched from the team's certs endpoint and refreshed on rotation;
fail closed on every error), requires the email to be in `ADMIN_ALLOWED_EMAILS`, and does so in `proxy.ts` (first gate) **and** again in every page and server action (`requireOperator`, because an action is reachable by a direct POST).
A source-level test fails if an admin page or action skips it, and lint stops admin pages importing anything but the data-access layer. People behind Access are recorded in a small `operators` table so staff actions have a stable actor id;
stage 3's `users` supersedes it and keeps the ids. Better Auth with MFA arrives in stage 3, where the roadmap put it. *Revisit if* operators need accounts that are not in the company's identity provider.

**D17. A human decision on a held lead must come from a human, with a reason, and the database enforces it.** A trigger refuses `held -> new` and `held -> rejected_fraud` unless the transaction names a staff actor and a reason, so no code path
(including a future one) can approve or reject silently. Reasons are a **closed list of codes** (`src/config/review.ts`), not free text, because free text would put consumers' details in `lead_status_history`, and because "approved as genuine"
is exactly a measurable false positive of the fraud screen. Concurrent decisions are serialised by a compare-and-set on `status = 'held'`: of ten simultaneous clicks exactly one wins (tested, and mutation-checked).

**D18. Error reporting sends only what we choose.** Sentry's v11 SDK replaced `sendDefaultPii` with `dataCollection`, whose defaults collect request bodies, cookies, headers and local variables. We disable every category, run no auto-instrumentation or breadcrumbs,
forward only a whitelist of ids and codes from log lines, and scrub every event again (emails, UK phone numbers, postcodes masked in what remains). The SDK is only loaded when `SENTRY_DSN` is set. Production refuses to start without it.
*What this cannot show:* a live Sentry project was not available, so the event content is verified with a capturing transport, not against Sentry itself.

### Stage 3 decisions

**D19. No Better Auth and no in-app MFA: staff sign in through Cloudflare Access, which enforces MFA. This deviates from the roadmap text for stage 3.** The app already refuses everything that does not carry a valid Access token (D16). A second login system inside the app would be a second
way in, a second place for MFA to be misconfigured, and a password store to defend, for a team of one to three people who are already behind their identity provider. Staff are rows in `operators` (id stable since stage 2) with a role: **owner** (listed in `ADMIN_OWNER_EMAILS`) or **staff**.
*The cost:* the app cannot check that MFA happened (Access tokens carry no `amr` claim), so it is a policy setting to verify, not a property the tests can prove: `runbook.md` makes "log in with only the first factor and confirm it is refused" the first-run check. *Revisit (adopt Better Auth or another in-app auth)* at stage 6, when clients log in and need accounts that are not in the company's identity provider; `users`/`client_users` arrive then.

**D20. The database refuses what the code must not do, and the code explains it.** The rules that protect money and consent are triggers and constraints, not just service checks: one active exclusive holder per lead and one active assignment per (lead, client) (partial unique indexes); the lead's `assigned` status needs an active assignment (deferred, so the status change and the assignment can happen in either order inside one transaction);
a cancel needs a named actor and a reason; the number of businesses never exceeds what the consent text promised; a withdrawn consent cannot be assigned; pricing rules cannot be edited, only ended; `audit_logs` is append-only. The service layer checks the same things first and turns a violation into a typed result the page can explain (`mapGuardError`), so a rule has two layers and the user only ever meets the friendly one.
Two surviving mutants in the mutation checks are this redundancy showing up, not a missing test.

**D21. Reasons are closed lists, never free text.** Taking a lead back, moving it, changing a client's status, erasing a person: each takes a code from a list in `src/config/` (so reports can count them), and the audit trail carries the code. A free-text box would invite a consumer's name or phone number into the audit log, which must hold no personal data (a deny-list in `writeAudit` refuses consumer fields, and a test asserts it).

**D22. Suppressions are keyed HMACs, not plain hashes.** A bare SHA-256 of an email or a UK phone number can be reversed by trying every candidate. `suppressions` stores HMAC-SHA-256 under `PRIVACY_HASH_KEY`, so a stolen database cannot be used to find out who asked to be forgotten. *The cost:* the key must never be rotated (every suppression would stop matching) and must be backed up separately from the database; production refuses to start without it. A person who asks again later updates `last_requested_at` (migration 0004), because "the latest request to stop counts".

**D23. Erasure is owner-only and survives a restore.** The page hides the button from staff and the service re-checks the role (a server action can be POSTed directly). Each erasure logs one line with the lead id and nothing else; `npm run ops:replay-erasures` reads the retained logs after a restore and blanks those leads again. This works because logs are retained independently of the database; it does not work if the log pipeline is down for the same period as the restore window, which the runbook calls out.

**D24. Never ask the connection pool for a second connection inside a transaction callback.** Found by a test, not by thinking: `clients.create` resolved the vertical id inside its transaction, so N concurrent creates against a pool of N each held a connection while waiting for another, and the pool deadlocked. The rule (in AGENTS.md) is to resolve anything you need *before* opening the transaction, or use the transaction's own handle. Lock order everywhere is lead, then assignment, then client, with an advisory lock per pricing scope and the client row lock for status and rule changes.

**D25. Stage 4 columns stay out of the schema until stage 4.** `client_working_hours`, `routing_rules`, `routing_runs`, `lead_assignments.routing_run_id` and similar remain in `docs/design/target-schema.sql` (now stages 4 to 10). A manual operator needs none of them, and an unused column is a promise the schema must keep. `docs/design/eligible-clients.sql` was deleted: the query is now real code (`src/modules/coverage`) and the tester uses the same function assignment uses.

### Stage 4 decisions

**Gate B was not passed before this was built.** The roadmap puts a paying roofer between stage 3 and stage 4 so the rules reflect real work. You asked for stage 4, so it exists, but it is built to be **switched off and cheap to be wrong about**: routing is off until an owner turns it on (D26), every rule is editable data (D29), and every decision can be explained and replayed. Treat the defaults (priority, fair share, daily and monthly caps, working hours) as a first guess to correct with what the first real roofers tell you.

**D26. Automatic routing is OFF by default, and only ever routes leads that arrive while it is ON.** `routing_settings.enabled` is an owner-only switch (audited, no deploy). Turning it on records `enabled_at`; leads created before that moment, leads older than `max_lead_age_hours` (24 by default), test leads, leads a person marked handled, and leads a person took back for a reason that needs a person are never taken. A backlog must never be sent to a business by surprise the moment someone flips a switch. *Revisit if* operators want the router to sweep a backlog on request (a one-off "route these" action, with a preview).

**D27. A lead is claimed, decided and assigned in ONE transaction under ONE advisory lock. This replaces the design in docs/03 (a `routing` status as a lease, a sweeper, a lock per client).** The old design existed so many workers could decide in parallel outside the lock and re-check inside it. At this business's volume (hundreds of leads a month, a decision is about 10 ms) parallelism buys nothing, and it costs three extra mechanisms (the lease, the sweeper, per-client locks) plus an approximate fairness under contention. With one lock: a crashed worker leaves the lead exactly as it was (still `new`, nothing to recover), caps and fair shares are **exact** rather than approximate (counts are read under the lock), and the decision code is the same whether it runs for real or as the admin's dry run. The `routing` lead status therefore exists but is never used. The chosen business is still locked (shared) and looked at again just before the assignment, because a person can pause it or change its coverage in the gap. *Revisit (parallel routing, per-client locks)* when routing time multiplied by peak leads per second passes about half a second per second; at 10 ms that is 50 leads per second, which is stage 10's problem, not this one's.

**D28. The router assigns; it does not deliver or charge.** Credits and charging are stage 6 and delivery is stage 5, so an automatic assignment is `reserved` at the price from the pricing rules and the operator still copies the message and presses "I've sent it", exactly as in stage 3. Because routing now makes the assignment before a person looks, **"Needs action" includes any assigned lead that has not been sent**, and the 15-minute reminder email covers it: otherwise a lead could be assigned automatically and then forgotten. This also applies to leads assigned by hand and left unsent (a deliberate change to stage 3's behaviour). *Revisit when* stage 5 delivers automatically.

**D29. Rules are data; invariants are not.** `routing_rules` rows (kind, position, parameters, on/off, version) are validated by a schema per type, editable only by an owner, versioned (a stale edit is refused, not overwritten) and audited. Filters and limiters all have to pass; rankers are tie-breakers applied in order. What is NOT a rule, because a switch would be a way to break a promise: the business is active and covers the postcode, a scheduled pause is a pause, weight 0 means "manual only", a business that already had this lead and gave it back does not get it again, the consumer's consent and suppression are honoured, and the router never invents a price. A stored rule that no longer validates **fails closed** (the lead is parked with an error run) instead of routing on rules nobody understands. Each run stores a snapshot of the rules in force, so editing a rule later never rewrites history.

**D30. A lead nobody can take is parked, not lost, and never retried in a loop.** It moves to `unroutable` (visible in Needs action, with a run that lists every business and why not), is announced once, and is looked at again when something relevant changes (a business activated or edited, coverage, hours, a pause, a price or a rule: a statement-level trigger bumps `routing_settings.poked_at`, deliberately touching one settings row and never a lead row, to avoid a lock cycle with the router) or after five minutes, until it passes the age limit. An **unexpected failure** after a lead is claimed records an `error` run and parks it for five minutes; a **database or network failure** (a killed connection, a failover, a timeout) does not park it at all: the transaction rolled back, the lead is still `new`, and the next poll takes it within seconds. `/api/pipeline` reports `routing_stalled` (a lead the router should have taken is still waiting after 60 s: the router is not running) and `routing_failing` (an error run in the last 10 minutes).

**D31. Two things in the design were left out on purpose.** `clients.max_open_leads`: "unanswered" cannot be measured until a client can accept or reject a lead (stage 6), so until then every sent lead would stay "open" for ever and the limit would starve the business permanently. An exclusion constraint on overlapping pauses: it needs the `btree_gist` extension, which a managed database may not let the migration install, for a rule that does not matter (a business is paused when any pause covers the moment).

**D32. What a take-back means for routing.** Taking a lead back because the business declined, did not answer, is the wrong area, or cannot take it **re-routes it automatically to a different business**. Taking it back for a quality concern, because the consumer asked, or for "another reason" **stops automatic routing for that lead** (an event, `lead.routing_stopped`): a person decides. Moving it to a named business ("Move it to another business") is atomic and never goes through the router.

**D33. Fair share counts leads a business holds, in its own time zone.** Daily and monthly caps and the fair-share window count assignments that are still active (reserved, notified, accepted, disputed): a lead taken back or refunded frees the room, and the day and month are the business's own (`clients.timezone`, Europe/London by default and not yet editable in the UI), so a Sydney roofer's "today" is Sydney's. Working hours are the same: a window in local time, one or more per day, with a stop-offering grace before closing, and a business with no hours at all is available at any time. Urgent leads do not override hours (a decision to revisit with a real roofer).

**D34. A killed database connection no longer takes the process down.** Found by the crash test for this stage: `pg` emits `error` on a connection that is checked out of the pool and in use, and nothing was listening, so a failover or an administrator killing a connection mid-transaction would have crashed the worker or the web process (the in-flight query was already failing correctly). `createDb` now listens on every connection. This affects all stages.

### Stage 5 decisions

**Delivery is per business and OFF by default (`manual`, exactly as in stage 3).** An operator switches a business to `automatic` on its client page after a test lead has reached them. The accounts a real deployment needs (a Twilio account and registered UK sender, the business's webhook, a verified sending domain) do not exist yet, so nothing here has met a real provider (section 3).

**D35. Every enabled channel is sent at once; there is no sequenced fallback.** The design had "primary then fallback after two minutes". Sending email, text and webhook together is simpler, never slower, and a duplicate notice to a business that asked for two ways of being told is not a defect. A lead counts as told when ANY channel is accepted. *Revisit* if a business complains about being told twice, or a channel's cost makes "also" expensive (Twilio is per message).

**D36. Notifications are created and cancelled by database triggers on the assignment.** `AFTER INSERT ON lead_assignments` writes one `notifications` row per enabled channel for a business on `automatic` delivery, in the SAME transaction, so "assigned but nobody told" is impossible whichever path assigned it (the router, an operator, a move). Another trigger cancels what has not gone out when the assignment ends. A trigger rather than a call from the assignment code because that code is reached from three modules and a fourth caller would have to remember; and because `assignments` importing `delivery` importing `assignments` would be a cycle. The row holds ids only: the message is built at send time, and the send re-checks that the assignment is still active, the lead is not erased and consent was not withdrawn.

**D37. What each channel carries.** Email: the full details, the same text an operator sends by hand (the business is entitled to them: it is the product). Text message: the minimum to act on (first name, phone number, area, job, urgency, reference), because a text is not a secure channel and sits on a phone indefinitely. Webhook: the full record, signed, over https to the business's own system. **[LEGAL]** confirm the consent wording and the privacy notice cover sending the details to the business by email, text and webhook, and list Twilio and the email provider as processors with their locations.

**D38. What delivery means for the assignment.** The first channel the provider accepts moves it `reserved -> notified` (as the system, reason `delivered_automatically`). If EVERY channel has finished and none went out, it moves to `delivery_failed`, the lead returns to `new` with a `lead.delivery_failed` event, and the router (or a person) gives it to a DIFFERENT business (the one that could not be reached already had it). Both are decided under the lead lock in one place (`settle`), idempotently. **What this does not do:** a text that Twilio accepted and then reports undelivered, when an email also went out, leaves the assignment `notified` and puts the failure in the "Deliveries that need you" queue and in `/api/pipeline` (`deliveries_failing`): nobody has confirmed the business was reached, and only a person can judge whether the email was enough. *Revisit* at stage 6, when the business can accept the lead and an unaccepted lead can expire.

**D39. Webhooks are defended as if the business's address were hostile.** https only, no credentials in the URL; the name is resolved and EVERY address must be public (IPv4 and IPv6, including IPv4 hidden in IPv6, cloud metadata and carrier-grade NAT); the connection goes to the address that was checked (no second lookup to rebind), with TLS verified against the original name; redirects are never followed; at most 64 KB of the answer is read and only the status code kept; 8 s hard timeout. 2xx = accepted; 408, 429 and 5xx retry; other 4xx and 3xx are permanent. Each delivery is signed `X-Leadgen-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + body)` with `X-Leadgen-Timestamp` (receivers reject more than five minutes old) and `X-Leadgen-Delivery` (the notification id, to de-duplicate: delivery is at-least-once). The signing secret has to be recoverable, so it is stored **encrypted** (AES-256-GCM, `DELIVERY_SECRETS_KEY`), shown to the operator once, and never readable again; losing the key loses every secret (rotate them). A webhook's circuit breaker is not built: a failing one is retried like any other and shown as failing since a date. *Revisit* with the stage-8 self-service integrations.

**D40. Twilio: hand-written signature check, no SDK, at-least-once texts.** The official SDK is 16 MB (axios, jsonwebtoken, dayjs...) for the one function we need, in a worker and a web process that otherwise have almost no dependencies. The documented algorithm (HMAC-SHA1 over the URL and the sorted parameters, compared in constant time) is reproduced exactly against Twilio's own published example in a test. Twilio has no idempotency key, so an attempt that timed out after Twilio accepted it can send a second text; the text carries the lead reference so a duplicate is recognisable. The callback endpoint (`/api/webhooks/twilio`) is public and believes nothing until the signature checks out; each (provider, event) is applied once; a report that beats our own bookkeeping is kept and applied by the reconciler; only the status and error code are stored (the report's phone numbers are not).

**D41. The worker starts notifications without waiting for them.** The first version claimed a batch and awaited all of it before claiming more, so one business whose server hangs (up to the 8 s timeout) delayed every other lead's delivery. Found by a test. Delivery now runs a bounded pool (20 in flight): a hung call holds one slot, not the queue; the lease, not the loop, protects a call that never returns. The operator-alert loop keeps batch-and-wait (its only provider is ours, and a stuck one is exactly what `/api/pipeline` reports).

**D42. No canary lead.** The roadmap asked for a synthetic lead to detect a stuck pipeline. `/api/pipeline` already reports it from facts: `deliveries_overdue` (a notification due for over two minutes), `deliveries_failing` (a failure on a live assignment, until a person retries or takes it back, or three days pass) and `deliveries_missing` (an automatic assignment with no notification at all: the trigger is broken). A synthetic lead would also have to avoid reaching a real business or polluting the numbers. *Revisit* if a failure mode appears that those three cannot see.

## 3. What could not be verified

Being explicit about the edges of the evidence:

- **ONSPD against a real file.** The importer is tested against synthetic CSVs in ONS's documented layout and refuses unexpected
  headers; I could not download the real 1 GB release. Run `--dry-run` first on the real file.
- **Real Turnstile keys.** Only Cloudflare's public test keys were exercised (against Cloudflare's real endpoint, which passed).
- **Anything provider-side:** Twilio, WhatsApp, Stripe, Railway and Cloudflare configuration. Nothing is provisioned.
  All designs are marked as designs.
- **Stage 2 against real services.** Everything below is tested against local stand-ins; where a vendor's documentation could be read, it was (2026-10-05) and is cited, but **nothing has been executed against the real service**:
  - *Resend* ([send](https://resend.com/docs/api-reference/emails/send-email), [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), [errors](https://resend.com/docs/api-reference/errors), [limits](https://resend.com/docs/api-reference/rate-limit)): the request shape, `Idempotency-Key` header (max 256 characters, kept 24 hours), the `{ "id" }` response and the error names in the adapter match the documentation.
    **Reading the idempotency page found a flaw in the first version of stage 2, now fixed:** a repeated key is only deduplicated when the **payload is identical**; the same key with a different payload is `409 invalid_idempotent_request` ("retrying is useless"). The first version rebuilt each alert's email on every retry from the current clock and the lead's
    current status, so a retry after a crash could differ and be rejected, losing the alert. Now each alert's email is a pure function of immutable facts (`src/modules/alerts/message.ts`), and a mismatch that still occurs (e.g. the recipient list changed mid-retry) rotates to a fresh key (a rare duplicate email is tolerated; a lost alert is not). Both are tested against a provider that enforces the rule.
    Default rate limit: **10 requests per second per team** (HTTP 429 with `retry-after`), raisable on request; the free plan also has a **daily** quota and every plan a monthly one (`daily_quota_exceeded` / `monthly_quota_exceeded`, also 429). A quota 429 is retried like any other but cannot clear inside the 53-minute retry window: on the free plan a busy day can exhaust it and alerts will go `dead` (the runbook says what to do). **Not documented, so unknown:** whether idempotency keys are scoped per API key or per team.
  - *Cloudflare Access* ([validating the token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)): the `Cf-Access-Jwt-Assertion` header, RS256, the `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` endpoint, the `aud` and `iss` checks, and 6-weekly key rotation with the previous key valid 7 more days all match the verifier. Service tokens carry no `email` and an empty `sub`, so they are refused as designed. The verifier has only ever seen tokens signed by a locally generated key, not one Cloudflare issued.
  - *Railway* ([config as code](https://docs.railway.com/config-as-code/reference), [healthchecks](https://docs.railway.com/deployments/healthchecks)): a pre-deploy command, start command, health-check path (a 2xx) and cron schedule are documented per-service settings, as the runbook assumes. Not executed.
- **Stage 5 against real providers.** Everything below is tested against local stand-ins (fake Twilio, a local webhook receiver, the existing fake email provider): **nothing has been sent through Twilio, a real email provider to a business, or to a real webhook receiver.** Specifically unproven: Twilio's response shapes beyond the documented 201 and error codes (read from documentation, not executed), that a real Twilio status callback arrives with the parameters and signature the handler expects (the signature algorithm is proven against Twilio's published example only), UK sender registration and delivery to real UK mobiles, TLS and SNI against a real business's server, the callback URL behind Cloudflare (the signature covers the exact URL: a proxy that rewrites it breaks verification), and how fast a real worker on Railway delivers (the local floor is a few hundred milliseconds).
- **Stage 4 against the real world.** The router, its rules and the worker's wake-up are tested against a local PostgreSQL, including a real worker process killed mid-route, but **not against Railway's Postgres or a real deployment**: the NOTIFY path, `lock_timeout` behaviour under a managed database's connection limits, and the worker restart policy are unproven there (runbook items 21-26). The fairness defaults, the 24-hour age limit and the five-minute retry are guesses to correct with real roofers (Gate B was not passed first). Latency was measured on one machine (see docs/07), so network distance to a managed database is not included. Working hours are applied to urgent leads too, which a real roofer may not want.
- **Stage 3 against the real world.** Everything is tested against a local PostgreSQL and a local fake Access key server; nothing has run against Cloudflare Access, Railway, Resend, Sentry or R2. In particular **MFA at Access is not verified** (D19), the keyed-HMAC suppression key has only ever been a local test key, and the replay-erasures procedure has been exercised against a synthetic log, not a real platform log export. The coverage rules were checked against the development postcode sample, not the full ONSPD file.
  - *Not checkable offline and not run:* email deliverability (SPF/DKIM/DMARC on the sending domain); Sentry has never received an event (the content is verified with a capturing transport); the backup script's `age` encryption and R2 upload (neither tool was installed), only dump, verify and restore; the first-run verification list in `runbook.md`.
- **Field performance.** Lighthouse is a lab simulation; real-user Core Web Vitals need RUM after launch.
- **Vendor prices and policies** quoted in 08-recommendation.md are indicative and must be re-checked at purchase.
- **Legal conclusions.** Nothing here is legal advice. Points needing a solicitor are marked **[LEGAL]**.
- **`experimental.inlineCss`** is an experimental Next.js 16 flag (measured improvement; removable by deleting one block).
