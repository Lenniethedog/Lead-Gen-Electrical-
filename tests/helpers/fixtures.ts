import type { Logger } from "pino";
import pino from "pino";
import { createLeadService, parseLeadSubmission, type LeadService, type SubmitLeadCommand } from "../../src/modules/leads";
import type { LeadSubmission } from "../../src/modules/leads";
import type { Database } from "../../src/lib/db/client";
import type { ChallengeResult, ChallengeVerifier } from "../../src/modules/fraud";
import { createPostcodeService } from "../../src/modules/postcodes/service";
import { createReferenceDataProvider } from "../../src/modules/reference";
import { CONSENT_VERSION } from "../../src/config/consent";

export const silentLogger: Logger = pino({ level: "silent" });

/**
 * Distinct, libphonenumber-valid UK mobiles for tests (07911 1xxxxx). Nothing in the test-suite
 * ever calls or texts them. (Ofcom's drama range 07700 900xxx is NOT usable: it is unallocated, so
 * real validation rejects it.)
 */
export function testMobile(n: number): string {
  return `07911 1${String(n % 100_000).padStart(5, "0")}`;
}

export const TEST_LANDLINE = "020 7946 0123";

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

type Json = Record<string, unknown>;

/** The raw JSON a browser would POST. Override any part with a deep-merge. */
export function wirePayload(overrides: Json = {}, n = 1): Json {
  const base: Json = {
    service: "fault_repair",
    postcode: "BR6 0AA",
    propertyType: "house",
    ownership: "owner",
    scope: "no_power",
    urgency: "within_2_weeks",
    contact: {
      name: "Alex Example",
      phone: testMobile(n),
      email: `alex.example${n}@example.com`,
      notes: "",
    },
    consent: { accepted: true, textVersion: CONSENT_VERSION },
    context: {
      elapsedMs: 45_000,
      turnstileToken: "XXXX.DUMMY.TOKEN.XXXX",
      honeypot: "",
      pagePath: "/",
      attribution: {},
    },
  };
  return deepMerge(base, overrides);
}

function deepMerge(target: Json, source: Json): Json {
  const output: Json = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = output[key];
    output[key] =
      value !== null && typeof value === "object" && !Array.isArray(value) && existing !== null && typeof existing === "object"
        ? deepMerge(existing as Json, value as Json)
        : value;
  }
  return output;
}

export function validSubmission(overrides: Json = {}, n = 1): LeadSubmission {
  return parseLeadSubmission(wirePayload(overrides, n));
}

let ipCounter = 0;
/** A fresh documentation-range address per command, so tests do not trip each other's IP-velocity signals. */
function nextTestIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.${(ipCounter % 7) + 1}`;
}

export function command(
  submission: LeadSubmission,
  overrides: Partial<SubmitLeadCommand["request"]> & { idempotencyKey?: string } = {},
): SubmitLeadCommand {
  const { idempotencyKey, ...request } = overrides;
  return {
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    submission,
    request: { requestId: `req-${crypto.randomUUID().slice(0, 8)}`, ip: nextTestIp(), country: "GB", userAgent: BROWSER_UA, ...request },
  };
}

export class FakeChallenge implements ChallengeVerifier {
  calls = 0;
  constructor(public result: ChallengeResult = { status: "passed" }) {}
  async verify(): Promise<ChallengeResult> {
    this.calls += 1;
    return this.result;
  }
}

export function buildLeadService(db: Database, challenge: ChallengeVerifier = new FakeChallenge()): LeadService {
  return createLeadService({
    db,
    postcodes: createPostcodeService(db),
    reference: createReferenceDataProvider(db, { ttlMs: 0 }),
    challenge,
    logger: silentLogger,
    verticalSlug: "electrical",
    ownHost: "localhost",
  });
}
