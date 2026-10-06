# Upstream: the roofing platform

This project is a **fork** of the roofing lead-generation platform, kept as a separate product on purpose (docs/00 D67, E1).
Nothing is shared at run time: separate repository, database, brand, domain, worker and deployment.

| | |
| --- | --- |
| Forked from | roofing repository `Lenniethedog/roofing-lead-gen`, commit **`3ae08d9`** ("Fix: admin and dashboard pages widened on a phone"), 2026-10-06 |
| Roofing's stage at the fork | Stages 1 to 6 built and tested locally (lead capture to business dashboard and credit ledger) |
| Last roofing commit reviewed for porting | `3ae08d9` (update this line every time you review upstream) |

## What the fork changed

Everything else is roofing's code, unchanged, so most roofing fixes apply as they are.

| Area | Files |
| --- | --- |
| The trade: services, follow-up questions, slug `electrical` | `src/config/verticals/electrical.ts` (roofing's `roofing.ts`; `ROOFING` became `ELECTRICAL`) |
| Emergency notice (999 / 105) | `src/config/safety.ts`, `src/components/lead-form/SafetyNote.tsx`, used in `src/app/page.tsx`, `UrgencyStep.tsx`, the FAQ |
| Wording | consent (`src/config/consent.ts`), urgency hint (`src/config/lead-options.ts`), landing page, form steps, confirmation, privacy notice, terms, the business dashboard's lead page, the handover message, page metadata |
| Brand | working title "SparkQuote Local" (`src/lib/env.ts`, `.env.example`), teal palette (`src/app/globals.css`), bolt mark and electrical icons (`src/components/landing/icons.tsx`), a circuit-trace hero pattern |
| Local set-up | web 3300, end-to-end 3310, key server 3399, PostgreSQL cluster on 54349 with `max_connections=200`, database `electrical_dev`, package name `electrical-lead-gen` |
| Demo data | `scripts/demo-data.ts`: fictional electrical businesses and enquiries |
| Tests | every roofing fixture became an electrical one; added `src/config/verticals/electrical.test.ts`, `src/config/no-roofing.test.ts`, `src/components/lead-form/SafetyNote.test.tsx`, `tests/integration/electrical.test.ts`, `tests/e2e/electrical.spec.ts`, and a pinned consent hash in `src/config/consent.test.ts` |
| Docs | README, this file, docs/00 (assumptions table, decisions E1-E5), AGENTS.md, trade words throughout `docs/` |

## Porting a fix from roofing

```bash
git fetch roofing                             # the remote is read-only use: never push to it
git log --oneline 3ae08d9..roofing/main       # what is new since the last review (use the commit in the table above)
git cherry-pick <commit>                      # one at a time; resolve conflicts in the files listed above
npm run check && npm run build && npm run test:e2e
```

- Roofing wording that comes with a fix (a test fixture, a label, "roofer") is turned into electrical wording;
  `src/config/no-roofing.test.ts` fails if any reaches the application.
- A roofing **migration** applies here as it is, but give it the same number only if this project has no migration of its own with
  that number. Never edit an applied migration in either project.
- Roofing decisions are numbered D1, D2...; boiler decisions B1...; electrical decisions E1... A ported decision keeps its D number.
- After a review, update "Last roofing commit reviewed" above, even when nothing was ported.

Porting the other way (a fix found here that roofing also needs) works the same: cherry-pick into the roofing repository and turn
electrical wording back into roofing wording.
