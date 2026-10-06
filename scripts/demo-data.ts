import "./_env";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { getBrand } from "../src/config/brand";
import { DEV_PRIVACY_HASH_KEY } from "../src/config/privacy";
import { ELECTRICAL } from "../src/config/verticals/electrical";
import { createDb } from "../src/lib/db/client";
import { createAssignmentService } from "../src/modules/assignments";
import { createClientService, parseClientInput, type CoverageRuleInput } from "../src/modules/clients";
import { createInboxService, ensureOperator, type Operator } from "../src/modules/inbox";
import { createLeadService, parseLeadSubmission } from "../src/modules/leads";
import { createPostcodeService } from "../src/modules/postcodes";
import { createPricingService } from "../src/modules/pricing";
import { createPrivacyService } from "../src/modules/privacy";
import { createReferenceDataProvider } from "../src/modules/reference";

// Loads a believable day of business into an EMPTY LOCAL development database: six electrical businesses (with routing preferences: priorities, weights, caps, hours, a pause, a manual-only one), prices, and fourteen enquiries in every
// state the operator will meet (needs action, held, approved, rejected, assigned, sent, taken back, moved, withdrawn, erased).
//
//   npm run db:demo            (after `npm run db:setup && npm run db:seed -- --dev-postcodes`)
//
// Everything goes through the real services (the same code the admin pages call), so the audit trail, history and alerts are genuine.
// Every name is fictional and every email is @example.com. Refuses to run unless APP_ENV=development, the database is on this
// machine, and it holds no leads or clients: it can never mix demo data into anything real.
const DEV_OPERATOR = process.env.ADMIN_DEV_EMAIL ?? "operator@example.test";

const CLIENTS = [
  {
    name: "Kestrel Electrical", contact: "Dave Hollis", email: "dave@kestrelelectrical.example.com", phone: "07123 411001",
    services: ["fault_repair", "consumer_unit", "lighting_sockets", "eicr"],
    rules: [{ mode: "include", kind: "outward", outward: "BR5" }, { mode: "include", kind: "outward", outward: "BR6" }] as CoverageRuleInput[],
    shared: false,
    prefs: { priority: 50, weight: 2, dailyLeadCap: 8, monthlyLeadCap: null, maxOpenLeads: null },
  },
  {
    name: "Tidewell Electrical", contact: "Aisha Rahman", email: "aisha@tidewellelectrical.example.com", phone: "07123 411002",
    services: ["fault_repair", "rewire", "consumer_unit"],
    rules: [{ mode: "include", kind: "area", serviceAreaSlug: "bromley" }, { mode: "include", kind: "outward", outward: "BR8" }] as CoverageRuleInput[],
    shared: false,
    prefs: { priority: 100, weight: 1, dailyLeadCap: null, monthlyLeadCap: null, maxOpenLeads: null },
    pauseFrom: "2026-11-02T09:00", pauseUntil: "2026-11-09T09:00",
  },
  {
    name: "Hartfield Electrical Co", contact: "Gary Pemberton", email: "gary@hartfieldelectrical.example.com", phone: "07123 411003",
    services: ["fault_repair", "rewire", "lighting_sockets"],
    rules: [{ mode: "include", kind: "area", serviceAreaSlug: "sevenoaks" }, { mode: "exclude", kind: "outward", outward: "TN15" }] as CoverageRuleInput[],
    shared: false,
    prefs: { priority: 100, weight: 1, dailyLeadCap: null, monthlyLeadCap: null, maxOpenLeads: null },
    hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, opens: "08:00", closes: "17:30" })),
  },
  {
    name: "Thames Gate Electrical", contact: "Luke Brennan", email: "luke@thamesgateelectrical.example.com", phone: "07123 411004",
    services: ["fault_repair", "consumer_unit", "rewire", "eicr", "ev_charger", "lighting_sockets", "other"],
    rules: [{ mode: "include", kind: "area", serviceAreaSlug: "dartford" }, { mode: "include", kind: "area", serviceAreaSlug: "gravesend" }] as CoverageRuleInput[],
    shared: true,
    prefs: { priority: 100, weight: 3, dailyLeadCap: null, monthlyLeadCap: 60, maxOpenLeads: null },
  },
  {
    name: "Northdown EV Charging", contact: "Imran Qureshi", email: "imran@northdownev.example.com", phone: "07123 411005",
    services: ["ev_charger"],
    rules: [{ mode: "include", kind: "radius", centerPostcode: "BR6 0AA", radiusMetres: Math.round(12 * 1609.344) }] as CoverageRuleInput[],
    shared: false,
    pause: true,
    prefs: { priority: 100, weight: 0, dailyLeadCap: null, monthlyLeadCap: null, maxOpenLeads: null }, // manual only
  },
  { name: "Ashgrove Electrical", contact: "Helen Marsh", email: "helen@ashgroveelectrical.example.com", phone: "07123 411006", services: [], rules: [], shared: false, prospect: true },
] as const;

const PRICES = [
  { serviceSlug: null, urgency: null, pence: 3500, saleType: "exclusive" },
  { serviceSlug: null, urgency: "emergency", pence: 4800, saleType: "exclusive" },
  { serviceSlug: "rewire", urgency: null, pence: 6000, saleType: "exclusive" },
  { serviceSlug: "ev_charger", urgency: null, pence: 4200, saleType: "exclusive" },
  { serviceSlug: "eicr", urgency: null, pence: 2500, saleType: "exclusive" },
  { serviceSlug: null, urgency: null, pence: 1800, saleType: "shared" },
] as const;

interface DemoLead {
  key: string;
  name: string; postcode: string; service: string; scope: string; urgency: string; property: string; ownership: string; notes?: string;
  kind: "new" | "held";
}

const LEADS: DemoLead[] = [
  { key: "A", name: "Margaret Oyelaran", postcode: "BR6 0AA", service: "fault_repair", scope: "no_power", urgency: "emergency", property: "house", ownership: "owner", notes: "Half the house lost power last night and the fuse board won't reset.", kind: "new" },
  { key: "B", name: "Colin Fairbrother", postcode: "BR5 1AA", service: "fault_repair", scope: "tripping", urgency: "within_2_weeks", property: "house", ownership: "owner", notes: "The kitchen circuit trips whenever the oven is on.", kind: "new" },
  { key: "C", name: "Priyanka Desai", postcode: "BR1 1AA", service: "rewire", scope: "full_rewire", urgency: "within_1_month", property: "house", ownership: "owner", kind: "new" },
  { key: "D", name: "Tom Whitcombe", postcode: "BR7 5AA", service: "ev_charger", scope: "home_charger", urgency: "within_2_weeks", property: "bungalow", ownership: "owner", notes: "Off-street parking; the fuse box is in the garage.", kind: "new" },
  { key: "E", name: "Sandra Kowalczyk", postcode: "TN13 1AA", service: "fault_repair", scope: "other_fault", urgency: "within_2_weeks", property: "house", ownership: "owner", kind: "new" },
  { key: "G", name: "Olivia Prentice", postcode: "BR8 7AA", service: "consumer_unit", scope: "replace_fuse_box", urgency: "within_1_month", property: "house", ownership: "owner", notes: "Old rewirable fuses, never been replaced.", kind: "new" },
  { key: "H", name: "Daniel Okafor", postcode: "DA11 0AA", service: "eicr", scope: "landlord_certificate", urgency: "within_2_weeks", property: "house", ownership: "landlord", kind: "new" },
  { key: "I", name: "Beth Lancaster", postcode: "BR6 0AA", service: "eicr", scope: "sale_or_purchase", urgency: "just_planning", property: "house", ownership: "owner", notes: "The buyer's surveyor asked for an electrical report before exchange.", kind: "new" },
  { key: "J", name: "Chris Doyle", postcode: "BR3 1AA", service: "fault_repair", scope: "socket_or_light", urgency: "within_2_weeks", property: "flat", ownership: "tenant", kind: "held" },
  { key: "K", name: "Nadia Hussain", postcode: "BR4 0AA", service: "fault_repair", scope: "tripping", urgency: "within_2_weeks", property: "house", ownership: "owner", kind: "held" },
  { key: "L", name: "Test Testing", postcode: "BR2 0AA", service: "other", scope: "need_advice", urgency: "just_planning", property: "house", ownership: "owner", kind: "held" },
  { key: "M", name: "Joyce Mackenzie", postcode: "TN14 5AA", service: "fault_repair", scope: "no_power", urgency: "within_2_weeks", property: "bungalow", ownership: "owner", kind: "new" },
  { key: "N", name: "Junk Entry", postcode: "BR1 1AA", service: "other", scope: "other_work", urgency: "just_planning", property: "house", ownership: "owner", kind: "new" },
  { key: "O", name: "Harry Bellamy", postcode: "DA1 1AA", service: "rewire", scope: "renovation_or_extension", urgency: "within_1_month", property: "house", ownership: "owner", notes: "Two-storey side extension, plans approved.", kind: "new" },
];

function must<T extends { ok: boolean }>(result: T, label: string): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`${label} failed: ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const appEnv = process.env.APP_ENV ?? "development";
  const host = new URL(url).hostname;
  if (appEnv !== "development" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`Refusing to load demo data: APP_ENV=${appEnv}, database host=${host}. Local development databases only.`);
  }

  const db = createDb({ url, ssl: process.env.DATABASE_SSL, poolMax: 4, applicationName: "leadgen-demo-data" });
  const logger = pino({ level: "silent" });
  try {
    const existing = await db.selectFrom("leads").select(db.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
    const existingClients = await db.selectFrom("clients").select(db.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
    if (Number(existing.n) > 0 || Number(existingClients.n) > 0) {
      throw new Error(`Refusing to load demo data: the database already has ${existing.n} leads and ${existingClients.n} clients. Use an empty one (see the header of this script).`);
    }

    const owner = await ensureOperator(db, DEV_OPERATOR.toLowerCase(), "owner");
    const staff: Operator = await ensureOperator(db, "priya@example.test", "staff");
    const rid = () => randomUUID();

    const privacy = createPrivacyService({ db, logger, hashKey: process.env.PRIVACY_HASH_KEY ?? DEV_PRIVACY_HASH_KEY });
    const clients = createClientService({ db, logger, verticalSlug: ELECTRICAL.slug });
    const pricing = createPricingService({ db, logger, verticalSlug: ELECTRICAL.slug });
    const assignments = createAssignmentService({ db, logger, brandName: getBrand().name, isSuppressed: privacy.isSuppressed });
    const inbox = createInboxService({ db, logger });
    const leadService = createLeadService({
      db,
      postcodes: createPostcodeService(db),
      reference: createReferenceDataProvider(db),
      // Stands in for Cloudflare Turnstile: a lead with a token passes, one without is held for review (as in the real form).
      challenge: { verify: async ({ token }) => (token ? { status: "passed" } : { status: "missing" }) },
      logger,
      verticalSlug: ELECTRICAL.slug,
      ownHost: "localhost",
    });

    // --- Clients ---------------------------------------------------------------------------------------------------------
    const clientId = new Map<string, string>();
    for (const demo of CLIENTS) {
      const parsed = parseClientInput({
        name: demo.name, contactName: demo.contact, contactEmail: demo.email, contactPhone: demo.phone,
        acceptsExclusive: "on", ...(demo.shared && { acceptsShared: "on" }),
      });
      if (!parsed.ok) throw new Error(`client ${demo.name}: ${JSON.stringify(parsed.errors)}`);
      const { id } = await clients.create({ operator: owner, client: parsed.value, requestId: rid() });
      clientId.set(demo.name, id);
      if ("prospect" in demo) continue;
      must(await clients.setServices({ operator: owner, clientId: id, serviceSlugs: [...demo.services], requestId: rid() }), `${demo.name} services`);
      for (const rule of demo.rules) must(await clients.addRule({ operator: owner, clientId: id, rule, requestId: rid() }), `${demo.name} rule`);
      must(await clients.setStatus({ operator: owner, clientId: id, status: "active", reason: "onboarded", requestId: rid() }), `${demo.name} activate`);
      if ("prefs" in demo) must(await clients.setRoutingPreferences({ operator: owner, clientId: id, prefs: demo.prefs, requestId: rid() }), `${demo.name} routing preferences`);
      if ("hours" in demo) must(await clients.setWorkingHours({ operator: owner, clientId: id, windows: [...demo.hours], requestId: rid() }), `${demo.name} hours`);
      if ("pauseFrom" in demo) must(await clients.addPause({ operator: owner, clientId: id, pause: { from: demo.pauseFrom, until: demo.pauseUntil, reason: "holiday" }, requestId: rid() }), `${demo.name} pause`);
      if ("pause" in demo) must(await clients.setStatus({ operator: owner, clientId: id, status: "paused", reason: "paused_by_client", requestId: rid() }), `${demo.name} pause`);
    }
    const client = (name: string) => clientId.get(name) ?? (() => { throw new Error(`no client ${name}`); })();

    // --- Prices ----------------------------------------------------------------------------------------------------------
    for (const price of PRICES) {
      must(await pricing.setPrice({ operator: owner, rule: { serviceSlug: price.serviceSlug, serviceAreaSlug: null, urgency: price.urgency, saleType: price.saleType, pricePence: price.pence }, requestId: rid() }), "price");
    }

    // --- Leads, through the real submission service ------------------------------------------------------------------------
    const consentVersion = (await db.selectFrom("consent_texts").select("version").orderBy("id", "desc").executeTakeFirstOrThrow()).version;
    const leadId = new Map<string, string>();
    const reference = new Map<string, string>();
    let n = 0;
    for (const demo of LEADS) {
      n += 1;
      const submission = parseLeadSubmission({
        service: demo.service, postcode: demo.postcode, propertyType: demo.property, ownership: demo.ownership, scope: demo.scope, urgency: demo.urgency,
        contact: { name: demo.name, phone: `07123 4${String(20000 + n * 137).slice(0, 5)}`, email: `${demo.name.toLowerCase().replace(/[^a-z]+/g, ".")}@example.com`, ...(demo.notes && { notes: demo.notes }) },
        consent: { accepted: true, textVersion: consentVersion },
        context: { elapsedMs: 45_000, ...(demo.kind === "new" && { turnstileToken: "demo-token" }), honeypot: "", pagePath: "/", attribution: {} },
      });
      const result = await leadService.submit({
        idempotencyKey: randomUUID(),
        submission,
        request: { requestId: rid(), ip: `203.0.113.${10 + n}`, country: "GB", userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1" },
      });
      leadId.set(demo.key, result.leadId);
      reference.set(demo.key, result.reference);
    }
    const lead = (key: string) => leadId.get(key) ?? (() => { throw new Error(`no lead ${key}`); })();

    // --- What the operators did with them ----------------------------------------------------------------------------------
    const assign = async (key: string, clientName: string, who: Operator, extra: { coverageException?: boolean } = {}) =>
      must(await assignments.assign({ operator: who, leadId: lead(key), clientId: client(clientName), requestId: rid(), ...extra }), `assign ${key}`);
    const send = async (assignmentId: string, who: Operator) => must(await assignments.markSent({ operator: who, assignmentId, requestId: rid() }), "mark sent");

    // A: urgent loss of power, handed to Kestrel and sent.
    await send((await assign("A", "Kestrel Electrical", owner)).assignmentId, owner);
    // B: handed to Kestrel, not sent yet.
    await assign("B", "Kestrel Electrical", staff);
    // C: handed to Tidewell and sent, then the homeowner withdrew consent.
    await send((await assign("C", "Tidewell Electrical", owner)).assignmentId, owner);
    must(await privacy.withdrawConsent({ operator: staff, leadId: lead("C"), requestId: rid() }), "withdraw C");
    // E: Hartfield did not answer, so it was taken back.
    const e = await assign("E", "Hartfield Electrical Co", staff);
    await send(e.assignmentId, staff);
    must(await assignments.cancel({ operator: staff, assignmentId: e.assignmentId, reason: "no_response", requestId: rid() }), "cancel E");
    // G: first given to Kestrel by exception (outside their patch), then moved to the business that covers it.
    const g1 = await assign("G", "Kestrel Electrical", staff, { coverageException: true });
    const g2 = must(await assignments.reassign({ operator: staff, assignmentId: g1.assignmentId, toClientId: client("Hartfield Electrical Co"), reason: "wrong_area", requestId: rid() }), "reassign G");
    await send(g2.assignmentId, staff);
    // H: Thames Gate, sent.
    await send((await assign("H", "Thames Gate Electrical", owner)).assignmentId, owner);
    // K: held, then approved. L: held, then rejected. J stays held for review.
    must(await inbox.approve({ operator: staff, leadId: lead("K"), reason: "verified_contact", requestId: rid() }), "approve K");
    must(await inbox.reject({ operator: staff, leadId: lead("L"), reason: "test_submission", requestId: rid() }), "reject L");
    // M: sold by hand outside the system, marked handled.
    must(await inbox.markHandled({ operator: owner, leadId: lead("M"), requestId: rid() }), "handle M");
    // N: junk entry erased by an owner.
    must(await privacy.erase({ operator: owner, leadId: lead("N"), reason: "test_data", requestId: rid() }), "erase N");
    // D (EV charger in BR7), I (BR6 electrical report), O (DA1 rewire) are left new, for the operator to work.

    const counts = await db
      .selectFrom("leads")
      .select(["status", db.fn.countAll<string>().as("n")])
      .groupBy("status")
      .orderBy("status")
      .execute();
    console.log(`Loaded ${CLIENTS.length} clients, ${PRICES.length} prices and ${LEADS.length} leads as ${owner.email} (owner) and ${staff.email} (staff).`);
    console.log(counts.map((row) => `  ${row.status}: ${row.n}`).join("\n"));
    console.log("Automatic routing is left OFF (an owner switches it on at /admin/routing). Open /admin/leads. To send the queued alert emails to the terminal, run `npm run worker` for a few seconds (EMAIL_PROVIDER=console).");
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
