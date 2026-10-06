# Documentation

Read in this order. Each document says what is **built** (and tested) and what is **designed** (not yet built).

| # | Document | Covers | Brief phases |
| --- | --- | --- | --- |
| 00 | [Assumptions and decisions](00-assumptions-and-decisions.md) | What was assumed, where the plan deviates from the brief and why, what could not be verified | n/a |
| 01 | [Architecture](01-architecture.md) | System shape, sync vs async, queue and cache decisions, scaling path, project structure | 0, 18 |
| 02 | [Data model](02-data-model.md) | Schema, postcode matching, lifecycles, exclusivity, attribution, monetisation | 1, 2, 11, 17 |
| 03 | [Routing and delivery](03-routing-and-delivery.md) | Routing engine, locking, notifications, retries, Twilio | 5, 6 |
| 04 | [Security and privacy](04-security-and-privacy.md) | Fraud model, UK GDPR, consent wording, security review | 7, 8, 13 |
| 05 | [Product surfaces](05-product-surfaces.md) | Client dashboard and admin: MVP vs later | 9, 10 |
| 06 | [Operations](06-operations.md) | Observability, performance targets and measurements, testing, deployment, launch checklist | 12, 14, 15, 16 |
| 07 | [Roadmap](07-roadmap.md) | Ten stages with acceptance criteria and what NOT to build | 19 |
| - | [Runbook](runbook.md) | Provisioning, first-run verification, deploys, backups and restores, incident procedures (stages 2 and 3) | 14, 15, 16 |
| 08 | [Recommendation](08-recommendation.md) | Final recommendation, costs, risks, what to change about the concept | 20 |

Code-level references: [`design/target-schema.sql`](design/target-schema.sql) is the remaining schema for stages 6–10, executable and
tested; `db/migrations/` (0001 to 0006) is the schema that exists today.

## What exists today

Stages 1 (lead capture), 2 (operator alerts, inbox, worker), 3 (clients, coverage, pricing, manual assignment, privacy tool), 4 (automatic routing) and 5 (instant delivery) are built and verified locally: **936 automated tests** (unit, component, integration against real PostgreSQL, including the real worker process killed mid-send, the double-sale races and many routers at once) plus **109 end-to-end checks** in real Chrome (phone and desktop; 1 skipped by design). Run `npm run check` and `npm run test:e2e`.
Stages 2 and 3 have run only against local stand-ins for Resend, Cloudflare Access and Sentry: the runbook lists what to verify against the real services first (including that Access enforces MFA, which the app cannot check). Gate A, the paid test with real electrical businesses, is a business test only the owner can run. Stage 4 was built before Gate B (a paying electrician), so treat its defaults as a first guess; routing is off until an owner switches it on. Stage 5 has been exercised only against local stand-ins for Twilio and a business's webhook. Nothing in stages 6–10 is implemented; the documents describing them are designs to review before each stage starts.
