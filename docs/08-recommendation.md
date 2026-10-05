# Final technical recommendation

Prices are **indicative** and must be re-checked at purchase; commercial statements are judgement, not market data. Legal points are for a solicitor.

## 1. Recommended architecture

A **modular monolith**: one Next.js web process and (from stage 2) one worker process over shared, framework-free domain modules and **one PostgreSQL** database that is the
record, the queue (transactional outbox) and the audit trail, behind Cloudflare. Atomic where it must be (lead + consent + audit; assignment + notification intent +
charge), asynchronous where it can fail (SMS, webhooks, email). Diagrams and rationale: [01-architecture.md](01-architecture.md).

## 2. Tech stack

| Concern | Choice | Why / note |
| --- | --- | --- |
| Web | Next.js 16 (App Router), React 19, TypeScript strict, Tailwind 4 | SSR/static pages, one codebase for form, API, dashboards. Static landing page, ~174 KB gzip JS |
| Validation | Zod 4 (shared schemas, `import * as z`) | One definition for browser and server; the server is authoritative |
| Data access | Kysely + `pg`, SQL migrations (node-pg-migrate), generated types | Typed queries without hiding SQL: needed for `SKIP LOCKED`, partial indexes, triggers |
| Database | PostgreSQL 17 | See 3 |
| Jobs | PostgreSQL outbox + `LISTEN/NOTIFY`; `graphile-worker` for scheduled jobs | See 4 |
| Phone / postcode | libphonenumber-js (full metadata), ONS Postcode Directory | Real validation, no regex stand-ins |
| Bot defence | Cloudflare Turnstile + own scoring | Free, invisible, privacy-respecting |
| Auth (stages 3, 6, 7) | Better Auth (Postgres sessions), passwordless clients, MFA staff | See 6 |
| Messaging | Twilio SMS, a transactional email provider (Resend or Postmark), signed webhooks; WhatsApp later | See 8 |
| Payments (stage 7) | Stripe Checkout + webhooks | Prepaid credit first |
| Logging / errors | pino JSON, Sentry (PII scrubbed), uptime + canary | See 06 |
| Tests | Vitest (unit, jsdom, real-Postgres integration), Playwright + axe | See 06 |
| CI | GitHub Actions with a Postgres service | Lint (incl. architecture rules), types, tests, build, e2e |

**Where I disagreed with your proposed stack:** no Redis (D1), no Vercel+Railway split (D2), no separate Node API (D3), no PostGIS yet (D4). Each has a written trigger for reversal.

## 3. Database

**PostgreSQL**, plain (no PostGIS yet). Relational integrity, partial unique indexes, exclusion constraints, triggers, `SKIP LOCKED` and transactional DDL are
exactly what lead ownership and money need, and one datastore means one thing to back up and reason about. Choose a provider with **point-in-time recovery** by ~1,000 leads/month.
Version 16 or newer.

## 4. Queue

**PostgreSQL** (outbox + `FOR UPDATE SKIP LOCKED` + `LISTEN/NOTIFY`), `graphile-worker` for cron/housekeeping. Eliminates the lead-saved-but-job-lost gap and runs thousands of jobs per second.
Revisit (BullMQ, then SQS if on AWS) only on the triggers in D1.

## 5. Hosting

**Railway** for web, worker and Postgres in one private project, **behind Cloudflare** (CDN, WAF, rate limit, Turnstile, DNS, TLS). Cheap, simple, long-lived processes next to the database.
Know the limits: the platform's EU region is not the UK (transfers to the EEA are covered by UK adequacy regulations **[LEGAL]**; if UK residency or HA becomes a requirement move to
AWS `eu-west-2` or Fly London), and its Postgres backups are snapshots, so add nightly off-platform dumps and a restore drill, and move to managed PITR at the trigger. The app is container-portable.

## 6. Authentication

- **Consumers:** none (no accounts, no passwords, nothing to breach).
- **Clients:** passwordless email link/OTP (passkeys later), Postgres sessions, `SameSite=Lax` `HttpOnly` cookies, tenant-scoped repositories + RLS.
- **Staff:** mandatory MFA (the database refuses an active staff user without it), behind Cloudflare Access on a separate subdomain, every action reasoned and audited.
- **Machines:** per-client API keys (hash stored, shown once) and HMAC-signed webhooks with timestamps.

## 7. Fraud strategy

Layered and recoverable: Cloudflare edge, invisible Turnstile (fail-open with a penalty), honeypot, UK phone/email validation, disposable-domain and placeholder checks, velocity and identity-reuse
signals, duplicate prevention serialised per person, a weighted 0-100 score with four bands where **uncertainty means "held for a human", not "rejected"**, identical responses so bots learn nothing,
and every signal persisted for tuning. Stage 8 adds blocklists, enrichment and an optional SMS-verified tier. Details: [04-security-and-privacy.md](04-security-and-privacy.md).

## 8. Notification architecture

Outbox rows created **in the assignment transaction**, woken by `NOTIFY`, claimed with `SKIP LOCKED`, sent through one `ChannelSender` interface (email, Twilio SMS, signed webhook; WhatsApp later),
retried with jittered exponential backoff, dead-lettered into an admin queue that can retry or reassign, reconciled every minute, and proven end to end by a canary lead. Never lose a lead because a
provider is down; tolerate a rare duplicate rather than risk a missed lead. Details: [03-routing-and-delivery.md](03-routing-and-delivery.md).

## 9. GDPR architecture

Platform = controller, each client = independent controller on receipt (controller-to-controller terms). **Consent captured per lead** against **versioned, immutable wording** that states the number
of recipients, which the router cannot exceed. Personal data isolated in `lead_contacts`; evidence append-only; erasure = one constrained operation plus a hashed suppression; retention periods in
one config file that both the notice and the retention job read; erasure log replayed after any backup restore; breach runbook with 72-hour clock. **Requires solicitor review before launch**
(`LEGAL_TEXT_REVIEWED` gate). Details in 04.

## 10. Estimated monthly infrastructure cost (GBP, indicative)

Assumptions: ~85% of leads are routed; ~1.1 SMS segments per routed lead at roughly **4p** per UK segment (verify current Twilio pricing and your negotiated rate); email within free or low tiers; Cloudflare
free until the Pro plan is wanted; Stripe fees (% of client payments) are a cost of revenue, not infrastructure.

| Leads / month | Compute + database | Messaging | Observability and tooling | **Approx. total** | What changes |
| --- | --- | --- | --- | --- | --- |
| **100** | £15-25 | ~£4 | £0 (free tiers) | **£20-35** | Web + Postgres (+ worker at stage 2) |
| **1,000** | £25-50 | ~£40 | £0-25 | **£70-120** | Verified backups; consider managed PITR |
| **10,000** | £120-300 (2 web, 2 workers, 2-4 GB Postgres with PITR) | ~£400 | £50-150 (Sentry team, log shipping, uptime, Cloudflare Pro) | **£600-900** | Redundancy; WhatsApp/email shifting some SMS |
| **100,000** | £1,000-2,500 (HA Postgres, 4+ app containers, replica) | £2,500-4,500 (negotiate rates; shift volume to WhatsApp/email/push) | £300-800 (observability, on-call, plan upgrades) | **£4,000-7,500** | Messaging dominates; engineering time, not servers, is the scaling cost |

At any plausible cost per lead, **ad spend dwarfs infrastructure by one to two orders of magnitude**; do not optimise hosting cost before lead quality, response speed and delivery reliability.

## 11. Biggest technical risks

1. **A lead silently lost or unseen** (worker down, expired provider credentials, bad deploy). *Mitigation:* atomic commit before response, outbox, reconciler, canary lead, alerts on "lead unseen > 60 s".
2. **Double-sale or double-charge.** *Mitigation:* database-enforced exclusivity, single-charge constraint, wallet floor; proven under concurrency (mutation-tested).
3. **Personal-data incident** (logs, backups, admin misuse, a mis-scoped client query). *Mitigation:* data isolation, redaction, least privilege, tenant-scoped repositories + RLS, audit trail, breach runbook.
4. **Postcode data wrong or stale** (misrouted or wrongly rejected leads). *Mitigation:* quarterly ONSPD refresh, importer sanity gates, coverage tester, footprint tied to real clients.
5. **Provider dependence and deliverability** (SMS filtering, sender registration, WhatsApp template rejection, Cloudflare outage). *Mitigation:* channel fallback, fail-open challenge, provider abstraction, status callbacks.
6. **Single-region/single-database failure.** *Mitigation:* tested restores, PITR at the trigger, container portability, documented RPO/RTO.
7. **Bot and click-fraud erosion** of ad ROI. *Mitigation:* scoring + held queue, click-IP exclusion feedback, offline conversion feedback so ad platforms optimise on sold leads.
8. **Operational complexity creep** (microservices, queues, caches added without evidence). *Mitigation:* the written triggers; lint-enforced boundaries; the "do not build yet" list per stage.

## 12. Biggest commercial risks

1. **Unit economics:** cost per *good* lead vs what a roofer will pay. Roofing is typically among the more expensive trades for clicks; model `cost per click / form conversion rate / valid-lead rate` against the price a client will actually pay for a lead they judge good, with a pessimistic case. Validate at Gate A before building more.
2. **Lead quality perception and disputes:** "tyre-kickers", tenants, outdated numbers. *Mitigation:* the qualification questions, exclusivity, outcome tracking, a clear dispute policy.
3. **Supply before demand:** buying traffic in postcodes where no paying roofer exists. *Mitigation:* the footprint is the set of districts with clients; ad geo-targeting mirrors it.
4. **Client concentration and churn:** a few roofers can be most of the revenue. *Mitigation:* client ROI reporting, outcome feedback, SLA on speed.
5. **Ad-platform policy and dependence:** you must be clearly an introduction service (the landing page and ad copy say so); one-channel dependence on Google. *Mitigation:* diversify later; keep claims substantiated.
6. **Regulatory and reputational exposure:** lead generation and third-party sharing are an enforcement focus; consumer-protection law (fake reviews, drip pricing, unsubstantiated "vetted/insured" claims) and rogue-trader reputation. *Mitigation:* consent design, no unsubstantiated claims, client onboarding checks **[LEGAL]**.
7. **Speed-to-lead depends on the roofer, not you:** a fast delivery to a slow contractor still loses the job. *Mitigation:* acknowledge/response-time tracking, re-routing for premium exclusives, client coaching.

## 13. What I would change about the concept

1. **Sell leads by hand to 3-5 roofers before building the marketplace** (stages 1-3). The hard questions are commercial; the routing engine is not what decides the business.
2. **Exclusive first, shared later**, and only on consented wording.
3. **Prepaid credit before subscriptions**, Stripe only after manual invoicing hurts.
4. **SMS + email + webhook before WhatsApp** (paperwork, approval and per-message cost; add on demand).
5. **Align advertising to client coverage** and optimise ad platforms on *sold leads* (offline conversions), not form fills.
6. **Treat the roofer's response speed as part of the product:** acknowledgement tracking and automatic re-routing for premium leads.
7. **Consider call tracking** (Twilio numbers on call-only ads): for trades, inbound calls are often a larger and higher-intent source than forms.
8. **Invest in outcome data from day one** (won/lost, job value): it is what lets you price leads, prove client ROI and improve targeting.

## 14. The minimum viable architecture to build first

**Stages 1 and 2, run manually:**

- One Railway project: **web** (landing page + API), **worker** (alerts, reconciler), **Postgres**; Cloudflare in front with Turnstile; Sentry free; an uptime check; nightly dumps to R2.
- An operator email per lead, a protected inbox to see new/held leads, and **you** forwarding good leads to the first roofers by WhatsApp, logging outcomes by hand.
- Nothing else: no client logins, no routing engine, no billing, no dashboards.

Stages 1 and 2 of this plan are **built and verified locally**. Stage 2's code is done; what stands between it and a live system is yours to provide: confirmation (or correction) of the niche and footprint; the company and brand
details for the footer and consent wording; a solicitor engaged for the legal review; an email provider account (the adapter is written for Resend) and a verified sending domain; the Railway and Cloudflare accounts (including a Cloudflare Access application for the admin host); a domain; a Sentry project; an uptime monitor; and the names of the first two or three roofers.
`docs/runbook.md` is the step-by-step for all of it, including how to confirm each piece works before a real lead depends on it.
