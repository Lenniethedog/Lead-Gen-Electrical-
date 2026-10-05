# Security, fraud and privacy

**Nothing here is legal advice.** Items marked **[LEGAL]** need a qualified UK data-protection solicitor before launch.
`LEGAL_TEXT_REVIEWED=true` is a production gate: the server refuses to start without it.

# Part A: Fraud, spam and duplicate prevention (built in stage 1; extended in stage 8)

## Layers

| Layer | Control | Status |
| --- | --- | --- |
| Edge | Cloudflare WAF, bot score, per-IP rate rule | Configure at deployment |
| Challenge | Cloudflare Turnstile (invisible unless Cloudflare needs interaction); server-side `siteverify` with the client IP and our idempotency key | **Built** |
| Form | Honeypot field; completion-time signal (client-reported, so weak) | **Built** |
| Request | Origin allowlist, JSON-only, 16 KiB streaming body cap, per-IP burst limit, uniform responses | **Built** |
| Identity | UK-only phone validated with libphonenumber metadata (rejects premium, personal, freephone, pager numbers); email shape + disposable-domain list; placeholder-name check | **Built** |
| Behaviour | IP velocity, phone/email reuse with a different identity | **Built** |
| Duplicates | Same job (vertical + service + outward code) from the same phone **or** email within the window; serialised per person with an advisory lock | **Built** |
| Blocklist | Hashed phone/email/domain/IP entries (`blocklist_entries`) | Designed, stage 8 |
| Enrichment | Email MX/deliverability, async phone line-type lookup, IP reputation (Cloudflare threat score, datacentre ASNs) | Designed, stage 8 |
| Verification | Optional SMS one-time code as a "verified lead" premium tier | Designed, stage 8 (costs conversion: measure first) |
| Ad platforms | Feed invalid-click IPs back to Google Ads exclusion lists; offline conversions so bidding optimises on *sold* leads, not form fills | Stage 9 |

## Score (0 to 100) and bands

The score is the capped sum of **distinct** signals. Weights and thresholds live in `src/config/fraud.ts` and are unit-tested; the table
below is generated from the same constants.

| Signal | Weight | Meaning |
| --- | --- | --- |
| `honeypot_filled` | 100 | A hidden field was filled: a bot |
| `blocklisted_identifier` | 100 | Known-bad phone/email/IP (check arrives with the blocklist, stage 8) |
| `automation_user_agent` | 60 | curl, python-requests, headless Chrome, Go/Java clients, or no user agent |
| `turnstile_missing` | 55 | No challenge token (blocker, script failure, or a bot): **held**, never rejected |
| `completed_too_fast` | 50 | Under 5 s from first render to submit for a six-step form |
| `tor_exit_node` | 40 | Cloudflare country `T1` (trusted only with the origin secret) |
| `ip_velocity_high` | 35 | 6 or more leads from this address in the last hour |
| `disposable_email` | 30 | Throwaway email domain |
| `placeholder_name` | 30 | "test", "asdf", "John Doe", "aaaa" ... |
| `url_in_notes` | 30 | A link in the free text |
| `phone_reused_with_other_identity` | 25 | Same phone, different email, within 7 days |
| `email_reused_with_other_identity` | 20 | Same email, different phone, within 7 days |
| `completed_quickly` | 20 | 5 to 10 s |
| `turnstile_unavailable` | 20 | Cloudflare/our config failed: we fail open with a penalty |
| `ip_velocity_elevated` | 15 | 3 to 5 leads from this address in the last hour |
| `voip_phone` | 15 | UK VoIP number |
| `non_uk_country` | 10 | Cloudflare country other than GB (VPN-tolerant: weak on purpose) |

| Score | Decision | What happens |
| --- | --- | --- |
| 0 to 24 | `accept` | Status `new`, routed |
| 25 to 49 | `flag` | Status `new`, routed, visible to staff and clients can dispute |
| 50 to 74 | `review` | Status `held`: **not routed until a human approves**; the consumer sees success |
| 75 to 100 | `reject` | Status `rejected_fraud`: stored for audit, never routed; the sender sees success |

**Calibration rules (tested in `fraud.test.ts`):** no single weak signal reaches the flag threshold, so a VPN, a shared office address or a
slow challenge never costs a lead; only honeypot and blocklist reject alone; uncertain-but-suspicious (automation UA, missing token,
machine-speed completion) lands in `review`, which is **recoverable**; every signal is persisted in `lead_fraud_signals` for explanation and
tuning, and contains no personal data. Review the held queue and false-positive rate weekly; weights belong in a table once the admin exists.

**Not made aggressive on purpose:** no visible CAPTCHA unless Cloudflare demands it, no blocking on VPN/country alone, no email-MX hard
rejection, no phone OTP in the default flow, no blocking on a missing Turnstile token. A real person never meets a wall they cannot pass.

---

# Part B: UK GDPR and data protection

## Roles and lawful basis **[LEGAL]**

- **The platform is the controller** of the consumer's data it collects. **Each client business is an independent controller** of the
  enquiry once it receives it (it decides how to use it to contact and quote). That is *controller-to-controller sharing*: it needs a
  data-sharing clause in the client contract (purpose limitation, security, deletion on request, no further sharing, notify us of
  withdrawal and breaches), not a processor agreement.
- **Processors** (a data-processing agreement each): hosting/database (Railway), Cloudflare, email and SMS providers, error tracking, backup storage.
- **Proposed lawful bases:** *consent* (Article 6(1)(a)) for passing details to a business and being contacted, because sharing with a
  third party is not something a consumer would assume without being told; *legitimate interests* for fraud prevention, security and
  aggregated marketing measurement; *legal obligation / legitimate interests* for records and defending claims.
  **PECR** (electronic marketing rules) is separate from UK GDPR. A consumer-requested callback about their own enquiry is not
  marketing, but the wording and any marketing add-on must be checked, as must TPS screening for any outbound marketing calls.
  Get the final basis, the PECR analysis and a DPIA recommendation confirmed by counsel; also confirm ICO registration and the data protection fee.

## Consent: the wording that is shipped, and the distinction you asked for

The consent text is a **versioned, immutable archive entry** (`consent_texts`), and each lead links to the exact version its consumer saw.
It must be **unticked, separate from terms, specific about who and how, and as easy to withdraw as to give** (see "Rights" below).
The text also fixes `recipient_model` and `max_recipients`, and the router may never exceed that number.

| Variant | When | Wording (brand and category substituted) | Router rule |
| --- | --- | --- | --- |
| **A. "We will contact you ourselves"** (first-party) | You, or your call centre, qualify the enquiry before any hand-off | "I agree that **{Brand}** may contact me by phone, text message or email about my roofing enquiry, including to help me find a suitable local roofing business. I have read the **Privacy Notice**." | `first_party`, `max_recipients = 0`: **no assignment to a client may be created** |
| **B. "We will share your details with a local business"** (shipped) | Each enquiry is passed to one business | "I agree that **{Brand}** may share the details I have entered with **one local roofing business that covers my area**, so that they can contact me by phone, text message, WhatsApp or email about my roofing enquiry. I have read the **Privacy Notice**." | `shared_one`, `max_recipients = 1` |
| **C. Shared with several** (only if you build shared leads) | Overflow/shared product | As B but "**up to {N} local roofing businesses** that cover my area" | `shared_multiple`, `max_recipients = N` |

Why the difference is technical, not cosmetic: in A the *platform* is the only party the consumer expects a call from, so passing the
lead to a business without fresh consent would breach purpose and consent limits; in B/C the consent *names the category and the number* of
recipients and the channels, which is what makes it "specific and informed". Changing the commercial model therefore means **publishing
new consent wording first** (`CONSENT_VERSION`), then enabling the model: the version check on submit and `/api/ready` enforce that order.

What is captured per consent: wording version, timestamp, page path, IP address and user agent (as evidence), in append-only
`consent_records`; withdrawal is a new row, never an edit. An optional email confirmation ("you asked us to ... reply STOP / withdraw
here") strengthens the evidence and is cheap to add in stage 2. A separate, unticked, optional box would be needed for any *marketing*:
none is collected, by design (data minimisation).

## Technical requirements checklist

| Requirement | Implementation |
| --- | --- |
| **Privacy notice** | `/privacy`, linked from the consent line and footer; draft template in code, driven by `src/config/privacy.ts` so promises and behaviour cannot drift; draft banner until `LEGAL_TEXT_REVIEWED` **[LEGAL]** |
| **Data minimisation** | Collected: postcode, property type, connection, work, timing, name, phone, email, optional note. Not collected: date of birth, address, photos, marketing preferences. Email is required (confirmation, duplicate and fraud signal, fallback contact): make it optional by changing one schema if the conversion trade-off favours it |
| **Purpose limitation** | Lead data is used to match, contact and screen; aggregate analytics use non-personal columns; no marketing use |
| **Retention** | `RETENTION` in `src/config/privacy.ts`: contacts 24 months, rejected/duplicate contacts 30 days, fraud-network data 90 days, consent evidence 6 years (proposed **[LEGAL]**). A nightly job (stage 8) blanks the personal columns (`erased_at`), never deletes rows |
| **Access** | Admin "export subject data": every table by lead or contact lookup, as JSON, after identity verification |
| **Rectification** | Admin edit of `lead_contacts` with an audit-log entry; tell the recipient business |
| **Erasure** | Blank `lead_contacts` and `leads.postcode` in one transaction (CHECKs prevent a half-erased row), add a **hashed suppression** (`suppressions`) so we remember not to contact without remembering who; tell the recipient business to delete (contractual). **Built (stage 3):** owner-only (the service re-checks the role, not just the page), reason from a closed list, one transaction, audited, safe to repeat (8 simultaneous requests leave one record); the suppression is a **keyed HMAC** (`PRIVACY_HASH_KEY`) of the email and phone, so it can be matched but not read, and it applies to a lead created *before* the request as well as after; the businesses that were sent the details are listed on the lead page so they can be told. After a restore, `npm run ops:replay-erasures` re-applies every erasure recorded in the retained logs (lead ids only) |
| **Withdraw consent** | Email (named in the notice and confirmation page) -> staff tool: append `withdrawn` consent record, stop further routing, notify the business to stop contacting, add suppression. Aim: as easy as ticking the box. **Built (stage 3):** any operator can record it from the lead page: it appends the `withdrawn` record, takes the lead back from any business that holds it, closes the lead, suppresses the person and lists the businesses to tell. The database refuses a later assignment of a lead whose consent was withdrawn, whatever code asks |
| **Objection / restriction** | Tracked in `data_subject_requests` with a due date (statutory one month) and an open-requests dashboard |
| **Delivery channels** | **Built (stage 5):** the notification tables hold ids and error codes only (tested with a distinctive contact across every table, the audit trail and the logs); a text carries the minimum (first name, phone, area, job); email and webhook carry the full details because the business is entitled to them; the send re-checks that the assignment is active, the lead is not erased and consent was not withdrawn; outgoing webhooks are SSRF-defended and signed, their secrets encrypted at rest; Twilio's reports are signature-verified and keep no phone numbers. **[LEGAL]** processors and transfers: Twilio and the email provider |
| **Sharing record** | `lead_assignments` (with `lead_assignment_status_history`) is the record of who received which lead and when. **Built (stage 3):** the price, the operator, the reason for every take-back and move, and whether a coverage exception was used are recorded; the consent's "how many businesses" limit is enforced by the database, not only by code |
| **Audit logs** | `lead_events`, `lead_status_history`, `consent_records`, `audit_logs`: append-only (trigger-enforced), no personal data in payloads (tested) |
| **Encryption in transit** | HTTPS everywhere (Cloudflare + HSTS in production), `DATABASE_SSL=verify-full` for any public database endpoint, signed webhooks over HTTPS only |
| **Encryption at rest** | Provider disk encryption; client signing secrets envelope-encrypted; API keys stored as hashes. Field-level encryption of phone/email is *possible* later (cost: key management, no SQL search); recommended only if a client or regulator requires it |
| **Access control** | Least-privilege database role; admin behind Cloudflare Access, which is where **staff MFA is enforced** (the application cannot see the second factor: the token has no `amr` claim, so the runbook's first-run check is to log in with only the first factor and confirm it is refused; there is no database CHECK for it); owner/staff roles from `ADMIN_OWNER_EMAILS`; tenant-scoped queries; staff actions need a reason and are audited |
| **Secrets** | Platform secret store; validated at startup; never logged; `.env*` git-ignored; rotation procedure in the runbook |
| **Backups** | Encrypted, off-platform copy, restore tested. **Erasure vs backups:** backups still contain erased data until they expire. Keep a log of erasures/suppressions and **re-apply it after any restore**, and state the backup retention in the notice **[LEGAL]** |
| **Breach response** | Runbook below; the audit trail and access logs must answer "which leads, which fields, which time range" within hours |
| **International transfers** | Sub-processor register with location; UK IDTA/Addendum or UK-US Data Bridge where providers process outside the UK **[LEGAL]** |
| **Storage and cookies (PECR)** | No analytics/advertising cookies today. Session-scoped `sessionStorage` holds form progress (cleared on submit/tab close; consent never persisted); attribution is read from the URL and stored nowhere in the browser. **Adding Google/Meta tags later requires a consent platform and consent mode first [LEGAL]** |

## Breach response (runbook outline)

1. **Detect:** alerts on anomalous access, error spikes, provider notices. 2. **Contain:** rotate secrets, revoke sessions/keys, block the vector.
3. **Assess within hours:** use the audit trail to list affected leads, fields and time range; judge risk to individuals. 4. **Notify the ICO within
72 hours** of becoming aware if there is a risk to individuals; notify affected people without undue delay if the risk is high; notify client
businesses (separate controllers) per contract. 5. **Record** every breach, including those not notified. 6. **Review** and fix the cause.

---

# Part C: Security review

| Area | Risk | Control and evidence |
| --- | --- | --- |
| **SQL injection** | Hostile free text reaching SQL | Every query is parameterised (Kysely builder or tagged `sql` templates); no string-built SQL. Evidence: `hostile input` integration test stores `'); DROP TABLE...` verbatim and the schema is intact. The app role cannot run DDL |
| **XSS** | Script in a name/notes shown to staff or clients later | React escapes by default; no `dangerouslySetInnerHTML`; names admit letters only; CSP restricts script sources. **Rule for stages 2-6:** any HTML email/SMS template must escape; never render notes as HTML |
| **CSRF** | Cross-site form posts | Public API has no ambient credentials (no cookies), accepts only `application/json` and an allowlisted `Origin`. Dashboards (stage 6) add `SameSite=Lax` cookies, Origin checks and framework CSRF protection |
| **Authentication** | Credential stuffing, weak admin access | Clients: passwordless email link/OTP and passkeys; staff: mandatory MFA (DB CHECK), Cloudflare Access in front of `/admin`; login rate limits; short admin sessions. Library choice: Better Auth (Postgres sessions). Stage 6/7 |
| **Authorisation / IDOR** | Client A reads client B's leads | uuid ids, `reference` is never authorisation; every client-facing repository function **requires a `clientId`**; row-level security as defence in depth in stage 6; cross-tenant tests are stage 6 acceptance criteria |
| **API abuse** | Floods, scraping, enumeration | Edge limits, per-IP burst limiter, body cap, idempotent writes, **identical responses** for accepted/held/duplicate/spam so nothing is learnable, coverage check rate-limited and POST-only |
| **Spoofed client IP** | Fake `X-Forwarded-For`/`CF-Connecting-IP` poisons velocity and consent evidence | Next.js passes client-supplied `X-Forwarded-For` through. `TRUST_PROXY=none` never trusts headers; `cloudflare` trusts `CF-Connecting-IP` **only** with the secret header Cloudflare injects (constant-time compare); `forwarded` counts from the right. Verified by tests and by probing a production build |
| **Secrets** | Leakage via repo, logs, errors | Validated at startup, names (not values) in errors, redaction list, `.gitignore`, production refuses Cloudflare test keys and placeholder details |
| **Inbound webhooks** (Twilio, Stripe) | Forgery, replay | Official signature validators; timestamp tolerance; `provider_events (provider, event_id)` processes each event once |
| **Replay of lead submissions** | Duplicate leads | Idempotency key unique in the DB; same key + different content -> 409; concurrent duplicates serialised |
| **Outbound webhooks (SSRF)** | A client URL pointing at our internal network | https only, DNS-resolution allow-check against private/loopback/link-local/metadata ranges (re-checked to defeat rebinding), no redirects, response cap |
| **Privilege escalation** | Staff or app exceeding duty | Three database roles over time (owner for migrations, app, read-only reporting); app role cannot delete or edit evidence; admin actions require reasons and are audit-logged |
| **Database exposure** | Direct access, dumps | Private network only; TLS; non-superuser app role; encrypted backups; no public endpoint except a controlled ops proxy |
| **File uploads** | Malware, SSRF via image fetch | None exist. If photo upload is added: pre-signed uploads to private object storage, type sniffing, size cap, malware scan, EXIF strip, served from a separate origin |
| **Sensitive logging** | PII in logs | Log ids/codes/counts only; pino redaction as a seat belt, tested (`logger.test.ts`); bodies never logged |
| **Denial of service** | Slow bodies, huge bodies, pool exhaustion | Streaming size cap, timeouts at every hop, statement/lock timeouts, bounded pool, origin behind Cloudflare |
| **Dependencies / supply chain** | Vulnerable or malicious packages | Lockfile, CI `npm ci`, `npm audit` (0 production vulnerabilities at time of writing), Dependabot, npm 11 install-script gating, a maintained disposable-domain list (refresh monthly) |
| **Admin security** | Takeover of the most powerful surface | Separate subdomain, Cloudflare Access (SSO/OTP), app MFA, IP allowlist optional, session pinning, every change audited |
| **Clickjacking / transport** | Framing, downgrade | `frame-ancestors 'none'`, `X-Frame-Options`, HSTS (production), `Referrer-Policy`, `Permissions-Policy`, `nosniff` |

Residual risks accepted for now: the in-process rate limiter is per instance; the CSP permits inline scripts (static rendering); Turnstile
fails open during a Cloudflare outage (with a score penalty); IP-based signals are inactive until `TRUST_PROXY` is configured for the deployment.
