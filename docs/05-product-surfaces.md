# Product surfaces: client dashboard and admin

**Status: design, except the stage-2 operator inbox and the stage-3 client, coverage, pricing, assignment and privacy screens, the stage-4 routing screens and the stage-5 delivery screens, which are built** (see "Stage 2 as built" to "Stage 5 as built" below); the full client dashboard is stage 6 and the full admin is stage 7 (the roadmap numbers the full admin as part of stage 8). This
document fixes scope so neither grows into a second product.

Shared foundations (decided now, built when needed):

- **App:** the same Next.js project; `/dashboard/*` for clients and `/admin/*` for staff, as separate route groups with separate
  layouts, auth guards and (for admin) a separate subdomain behind Cloudflare Access.
- **Auth:** **staff** sign in through Cloudflare Access, which enforces MFA, verified again in the app (decision D19: no in-app staff login, so there is no second way in); **clients** (stage 6) get Better Auth with Postgres sessions, passwordless (email link or OTP, passkeys later). The
  original design had the schema forbid an active staff user without MFA; that is not possible when the second factor happens outside the app. `client_users` links users to a client with a role (`owner`, `manager`, `agent`).
- **Authorisation:** server components/actions call a repository that **requires** the acting `clientId` (or a staff role). RLS on
  `lead_assignments`, `notifications`, `credit_ledger`, `lead_charges`, `disputes` as defence in depth.
- **Data exposure:** a client sees a lead's consumer contact details **only for assignments it holds** and only while the assignment is
  active or accepted. A client can never list leads it was not assigned.
- **Everything mutating** goes through a service function that sets the audit context (`app.actor_type`, `app.actor_id`, `app.reason`),
  so history rows are written by the database triggers.

## Client dashboard (stage 6)

| Capability | MVP | Later | Notes |
| --- | --- | --- | --- |
| New leads | Yes: list of `reserved/notified` assignments, newest first, with a one-tap call/email link | Live push (SSE) | Time since assigned is shown prominently: speed-to-lead is the product |
| Lead detail | Yes: job summary, contact details, urgency, property, notes, reference | Photos, map of the postcode district | Contact details revealed only for held assignments |
| Lead history | Yes: paginated, filter by status/date | Saved views, export CSV | |
| Accept / reject | Yes: accept (starts the clock for outcome reporting); reject with a reason, which feeds quality scoring and frees the lead | Auto-accept rules | Rejecting is a business decision; a *dispute* is for "this lead is bad" |
| Contact attempts and outcome | Yes: log call result and, when known, job won/lost and value (`assignment_contact_attempts`) | Call tracking integration, reminders | This is the data that proves client ROI and trains lead quality |
| Disputes | Yes: raise within a window (default 7 days) with a reason and note; see status and resolution | Evidence upload, auto-resolution rules for clear-cut reasons (duplicate, out of area) | One open dispute per assignment (DB-enforced); refund is a ledger credit, never an edit |
| Credits and billing | Yes: balance, ledger, top-up through Stripe Checkout, invoices as Stripe-hosted links | Auto-recharge, spend caps, VAT invoices in-app | Prepaid credit first: simplest, no collections risk |
| Subscription | View current plan and period allowance | Self-serve plan change, proration | Sold manually at first |
| Service areas and postcodes | **Read-only** view of covered districts and a "request change" action | Self-serve editor (outward/sector picker, radius with map) | Coverage drives revenue and fraud-sensitive routing; staff edit initially, with audit |
| Notification settings | Yes: phone numbers, emails, quiet hours, which channels | Per-service routing of notifications, team rotas | |
| API / webhook settings | No | Webhook URL + signing-secret rotation, API keys, delivery log with replay | Needs the SSRF defences in 03-routing-and-delivery.md first |
| Conversion tracking | Outcome logging (above) | Conversion funnel per source, cost per won job | |
| Performance analytics | Counts: received, accepted, contacted, won; response time; spend | Trend charts, cohort quality, benchmark vs other clients | Derived from the same tables, no separate analytics store |

**Explicitly not in the MVP dashboard:** multi-location accounts, team rotas, in-app chat with consumers, a coverage map editor, custom
reports. Each is a stage after real clients ask.

## Admin platform (stage 7; a thin version of lead inbox in stage 2)

| Area | Capabilities | Notes |
| --- | --- | --- |
| **Leads** | Search by reference/phone/postcode/status; full detail with the entire timeline (events + status history + fraud signals + routing run + notifications); approve/reject **held** leads; mark invalid; reopen overrides | The held-lead queue is the fraud team's daily tool |
| **Manual reassign** | Choose a client, give a **mandatory reason**; the current assignment is cancelled (charge reversed as a ledger entry), a new one is created with `assigned_by = staff`, notifications are queued, and an `audit_logs` row records before/after, actor, reason, IP and request id | History triggers capture the actor, so the trail cannot be skipped; the exclusivity index makes a double-sale impossible even here |
| **Clients** | Create/edit, status (prospect/active/paused/suspended), caps, priority/weight, working hours, services, coverage rules, users | Every edit audited |
| **Postcodes and areas** | Footprint management; look up a postcode (district, area, coordinates, terminated?); coverage test ("which clients would receive a lead here?" using the real routing query); last ONSPD import | |
| **Routing rules** | View and edit ordered rules and parameters; **dry-run any lead** and see the engine's reasons; rules version history | Edits validated and audited; see 03-routing-and-delivery.md |
| **Lead pricing** | `pricing_rules` editor with effective dates; preview the price a lead would get | History is immutable: assignments snapshot their price |
| **Credits and subscriptions** | Grant/adjust credit (reason required, ledger entry), view ledger, manage plans and subscriptions, reconcile wallet vs ledger | Adjustments are `adjustment` ledger entries by a named staff member |
| **Disputes** | Queue with the lead, the client's reason and the timeline side by side; uphold (choose resolution: credit, replacement) or reject with a note | Upholding writes the refund ledger entry and ends the assignment in one transaction |
| **Fraud** | Held queue, signal breakdown per lead, blocklist management, false-positive rate, weight tuning (later) | |
| **Campaigns** | Campaign list, spend import status, the funnel view (spend -> leads -> valid -> sold -> revenue, CPL, ROAS), UTM template generator | |
| **Notifications and webhooks** | Delivery queue, failures/dead letters with one-click retry or reassign, per-integration health, attempt timeline, replay | The "did the client actually get it?" screen |
| **System health** | Readiness checks, queue depth and age, oldest `new` lead, notification latency percentiles, error rate, last reconciler run, postcode data age, consent archive status | Same signals as the alerts in 06-operations.md |
| **Audit logs** | Searchable by entity, actor, action, time; read-only | The incident-reconstruction tool |
| **DSR (privacy requests)** | Open requests with due dates, identity verification step, export / erase / withdraw-consent actions | Statutory one-month clock |

**Stage 2 stand-in:** before any of the above, the operator needs only a protected page listing `new`/`held` leads with contact details and
an email/WhatsApp alert per lead, so the first leads can be sold by hand and the business can be validated before routing is built.

**Stage 2 as built (the whole of the admin that exists):** `/admin/leads` with three views (Needs action, Handled, Screened out), newest first, capped at 200 with a banner naming how many are hidden; `/admin/leads/[id]` with the contact details (this is the only place they appear), the job, the screening signals
and their weights, consent version, the alert emails' state, and a timeline merged from `lead_events` and `lead_status_history` naming the operator. Actions: approve or reject a **held** lead with a reason from a closed list,
and **mark a new lead handled** (an event, not a status: a manually sold lead has no assignment yet, so `assigned` would be a lie). The list never carries personal data. There is no search, filtering beyond the three views, editing, reassignment, client management or export: all later.
It refreshes itself every 20 s while open, and works on a phone (operators will open alert emails there). **Until stage 3, keep your own log of which business received each lead** (reference, business, time): the consent allows one business per lead and a data-subject request will ask who got the details.

**Stage 3 as built (added to the admin; navigation: Leads, Clients, Coverage, Pricing):**

| Page | What it does |
| --- | --- |
| `/admin/clients`, `/admin/clients/new`, `/admin/clients/[id]` | List by status; create and edit a business (name, contact person, email and phone for sending leads, whether it takes exclusive and/or shared leads); services; coverage rules (district, sector, prefix, named area, radius; include or exclude); status changes (reason required to pause, suspend or churn; an `active` client must have a service and an include rule). |
| `/admin/coverage` | The coverage tester: a postcode, a service and a lead type give every client with the reason it was or was not eligible. It runs the same code as assignment. |
| `/admin/pricing` | Set a flat price per lead by service, area, urgency and lead type; the current prices; the history of ended ones. |
| `/admin/leads/[id]` (extended) | **Businesses**: hand the lead to a business (the list says who covers the postcode; a coverage exception is a ticked, recorded choice; the price comes from the rules or is asked for), the ready-made message to copy, "I've sent it", take it back or move it (reason required), and each hold's history. **Privacy**: record a withdrawal of consent (any operator) and erase a person (owners only), with the list of businesses to tell afterwards. A new "Assigned" view lists leads a business holds. |

Everything here goes through the data-access layer, which authenticates in every function; the audit trail records who did what, with codes and ids, never a consumer's personal data. Not built: client logins, the dashboard, search by name or phone, subject-access export, user management (operators are added in the environment configuration).

**Stage 4 as built (navigation: Leads, Clients, Coverage tester, Pricing, Routing):**

| Page | What it does |
| --- | --- |
| `/admin/routing` | The **switch** (owner only; switching on needs a tick and only affects leads that arrive afterwards), **the last 24 hours** (leads routed, nobody could take it, errors, how long a decision takes), **the rules** (in use or not, their settings, and the order of the tie-breakers; owner-editable, versioned, audited; staff read-only), the age limit, and **recent decisions** with a link to each lead. |
| `/admin/clients/[id]` (extended) | **Automatic leads**: priority, weight (0 = manual only), most leads a day and a month, working hours per weekday in the business's own time zone, and pauses (add, remove, "end it now"). |
| `/admin/leads/[id]` (extended) | **Routing**: what the router did and why (a verdict for every business that covers the lead, with its rank and the numbers behind it, and the businesses that do not cover it, folded away), earlier attempts, and "Who would get this lead if the router looked at it now?" (a read-only dry run that also says why the router would leave it alone). An unroutable lead can be handed over by hand. |
| `/admin/leads` (changed) | **Needs action now also holds** leads nobody could route and leads assigned (by a person or the router) but **not yet sent**; the badge says "Nobody could take it" or "Assigned: send it". |

Not built: client logins, the dashboard, a rule editor for new kinds of rule (those need code), a coverage map.

**Stage 5 as built (navigation adds Deliveries):**

| Page | What it does |
| --- | --- |
| `/admin/clients/[id]` (extended) | **How they are told**: manual or automatic; email, text message and webhook tick-boxes; the webhook address; and a webhook signing secret that is generated, **shown once** (never in a URL), stored encrypted and never readable again (only its last four characters). Saves are audited. |
| `/admin/leads/[id]` (extended) | Under the business: **Sent automatically** with each channel's state (waiting, sending, failed and trying again, sent, delivered, failed, gave up), a "Try again" on a failed one, and "Send it yourself instead" folded away while automatic delivery is still working. |
| `/admin/deliveries` | **Deliveries that need you**: failed and dead notifications from the last three days with the reason in plain words and "Try again" (only while the lead is still with that business). |

Not built: the client dashboard and client-side acceptance (stage 6), several webhooks per business and client API keys (stage 8).

**Stage 6, slice 1 as built (the business dashboard: sign-in and the leads it holds).** `/dashboard/login` (ask for a link), `/dashboard/signin?token=` (a page with one button), `/dashboard` (New leads: the leads the business holds, newest first, refreshing every 30 s), `/dashboard/history` (ended ones: job details only) and `/dashboard/leads/[id]` (a tap-to-call button and the person's details **while the business holds the lead**, plus the job). Staff manage who can sign in on each client's page ("People who can sign in": invite, email a new link, change role, disable and enable); every action is audited. A business sees only its own leads (three layers, D45); a lead it was never told about is not listed; every reveal of a person's details is audited.

**Slice 2 as built.** A lead awaiting an answer shows **Accept this lead** and **Decline** (with a reason). A declined lead leaves New leads, appears in History as Declined without the person's details, and goes to a different business. An accepted lead shows **How did it go?**: outcome (no answer, voicemail, spoke, wrong number, not interested, quote sent, won, lost), an optional value (only for a quote or a win) and a note, listed newest first. Staff can set "Most unanswered at once" per business (client page, Automatic leads). The worker clears out old sign-in links and sessions hourly.

**Slice 3 as built.** Client page, **Billing and credit**: how they pay (invoiced or prepaid), the credit balance and this month's charges, a form to record a payment received, give free credit or correct a mistake (reason from a list, amount in pounds, pressing twice records once), the credit ledger, and the charges to invoice from. Dashboard, **Billing** (owners and managers; agents do not see it): credit remaining (prepaid), charged this month, credit history and leads charged. A prepaid business with too little credit is not given leads (routing skips it; a person assigning by hand is told why). Added to the health check: `money_does_not_add_up`.

Not built yet in stage 6: disputes, notification settings, the read-only service-area view, performance counts. Roles: an agent works the leads and cannot see Billing; owners and managers can.
