import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsent } from "../../src/config/consent";
import { SlidingWindowRateLimiter } from "../../src/lib/rate-limit";
import { createPostcodeService } from "../../src/modules/postcodes/service";
import { createReferenceDataProvider } from "../../src/modules/reference";
import { handleCheckPostcode } from "../../src/server/handlers/check-postcode";
import { handleHealth, handleReady } from "../../src/server/handlers/health";
import { handleSubmitLead, MAX_BODY_BYTES, type SubmitLeadDeps } from "../../src/server/handlers/submit-lead";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildLeadService, FakeChallenge, silentLogger, wirePayload } from "../helpers/fixtures";

const ORIGIN = "http://localhost:3000";
let t: TestDatabase;
let n = 500;

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.destroy();
});

function submitDeps(overrides: Partial<SubmitLeadDeps> = {}, challenge = new FakeChallenge()): SubmitLeadDeps {
  return {
    leadService: buildLeadService(t.db, challenge),
    logger: silentLogger,
    // forwarded + 1 hop: the right-most X-Forwarded-For entry is the client, as behind a single proxy.
    ipConfig: { mode: "forwarded", trustedHops: 1 },
    allowedOrigins: [ORIGIN],
    rateLimiter: new SlidingWindowRateLimiter({ limit: 100, windowMs: 60_000 }),
    ...overrides,
  };
}

let ipCounter = 0;
function leadRequest(body: unknown, headers: Record<string, string> = {}): Request {
  ipCounter += 1;
  return new Request(`${ORIGIN}/api/v1/leads`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "idempotency-key": crypto.randomUUID(),
      "x-forwarded-for": `198.51.100.${(ipCounter % 250) + 1}`,
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/v1/leads", () => {
  it("creates a lead: 201 with only the reference, a request id, and no caching", async () => {
    const response = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1))), submitDeps());
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(/\S{8,}/);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data)).toEqual(["reference"]);
    expect(body.data.reference).toMatch(/^L-[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it("answers a retry with 200 and the same reference, flagged as a replay", async () => {
    const deps = submitDeps();
    const key = crypto.randomUUID();
    const payload = wirePayload({}, (n += 1));
    const first = await handleSubmitLead(leadRequest(payload, { "idempotency-key": key }), deps);
    const retry = await handleSubmitLead(leadRequest(payload, { "idempotency-key": key }), deps);
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(((await retry.json()) as { data: { reference: string } }).data.reference).toBe(
      ((await first.json()) as { data: { reference: string } }).data.reference,
    );
  });

  it("answers identically whether a lead is accepted or silently rejected as spam", async () => {
    const deps = submitDeps();
    const good = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1))), deps);
    const bot = await handleSubmitLead(leadRequest(wirePayload({ context: { honeypot: "buy now" } }, (n += 1))), deps);
    expect(bot.status).toBe(good.status);
    expect(Object.keys(((await bot.json()) as { data: object }).data)).toEqual(Object.keys(((await good.json()) as { data: object }).data));
  });

  it("requires a well-formed Idempotency-Key", async () => {
    const missing = leadRequest(wirePayload({}, (n += 1)), { "idempotency-key": "" });
    expect(((await (await handleSubmitLead(missing, submitDeps())).json()) as { error: { code: string } }).error.code).toBe("idempotency_key_required");
    const invalid = leadRequest(wirePayload({}, (n += 1)), { "idempotency-key": "not-a-uuid" });
    const response = await handleSubmitLead(invalid, submitDeps());
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("idempotency_key_invalid");
  });

  it("returns 422 with one message per bad field, and never echoes the submitted personal data", async () => {
    const response = await handleSubmitLead(
      leadRequest(wirePayload({ contact: { phone: "12345", email: "secret.person@nowhere" }, postcode: "zzz" }, (n += 1))),
      submitDeps(),
    );
    expect(response.status).toBe(422);
    const text = await response.text();
    const body = JSON.parse(text) as { error: { code: string; fields: Record<string, string>; requestId: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(Object.keys(body.error.fields).sort()).toEqual(["contact.email", "contact.phone", "postcode"]);
    expect(body.error.requestId).toBeTruthy();
    expect(text).not.toContain("secret.person");
    expect(text).not.toContain("12345");
  });

  it("rejects wrong content types, malformed JSON and oversized bodies before touching the database", async () => {
    const deps = submitDeps();
    const wrongType = leadRequest("a=b", { "content-type": "application/x-www-form-urlencoded" });
    expect((await handleSubmitLead(wrongType, deps)).status).toBe(415);
    expect((await handleSubmitLead(leadRequest("{broken"), deps)).status).toBe(400);
    const huge = leadRequest({ ...wirePayload({}, (n += 1)), padding: "x".repeat(MAX_BODY_BYTES) });
    expect((await handleSubmitLead(huge, deps)).status).toBe(413);
  });

  it("blocks browsers on other origins", async () => {
    const response = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1)), { origin: "https://evil.example" }), submitDeps());
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("forbidden_origin");
  });

  it("rate limits per client IP with Retry-After, but not clients whose address is unknown", async () => {
    const limited = submitDeps({ rateLimiter: new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000 }) });
    const ip = { "x-forwarded-for": "198.51.100.200" };
    const statuses: number[] = [];
    let blocked: Response | undefined;
    for (let i = 0; i < 4; i += 1) {
      const response = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1)), ip), limited);
      statuses.push(response.status);
      if (response.status === 429) blocked = response;
    }
    expect(statuses).toEqual([201, 201, 429, 429]);
    expect(Number(blocked?.headers.get("retry-after"))).toBeGreaterThan(0);

    // A different client is unaffected.
    const other = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1)), { "x-forwarded-for": "198.51.100.201" }), limited);
    expect(other.status).toBe(201);

    // Unknown address (mode none): never share one bucket between everybody.
    const anonymous = submitDeps({
      ipConfig: { mode: "none", trustedHops: 1 },
      rateLimiter: new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 }),
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await handleSubmitLead(leadRequest(wirePayload({}, (n += 1))), anonymous)).status).toBe(201);
    }
  });

  it("maps domain rejections to retryable, specific errors", async () => {
    const failedChallenge = submitDeps({}, new FakeChallenge({ status: "failed", codes: ["timeout-or-duplicate"] }));
    const challenge = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1))), failedChallenge);
    expect(challenge.status).toBe(403);
    expect(((await challenge.json()) as { error: { code: string } }).error.code).toBe("challenge_failed");

    const area = await handleSubmitLead(leadRequest(wirePayload({ postcode: "SW1A 1AA" }, (n += 1))), submitDeps());
    expect(area.status).toBe(422);
    const areaBody = (await area.json()) as { error: { code: string; fields: Record<string, string> } };
    expect(areaBody.error.code).toBe("out_of_area");
    expect(areaBody.error.fields.postcode).toBeDefined();

    const stale = await handleSubmitLead(leadRequest(wirePayload({ consent: { textVersion: "v99" } }, (n += 1))), submitDeps());
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe("consent_outdated");

    const key = crypto.randomUUID();
    const deps = submitDeps();
    await handleSubmitLead(leadRequest(wirePayload({}, (n += 1)), { "idempotency-key": key }), deps);
    const reuse = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1)), { "idempotency-key": key }), deps);
    expect(reuse.status).toBe(409);
    expect(((await reuse.json()) as { error: { code: string } }).error.code).toBe("idempotency_key_reuse");
  });

  it("turns an unexpected failure into a generic 500 that leaks nothing", async () => {
    const broken: SubmitLeadDeps = submitDeps({
      leadService: { submit: () => Promise.reject(new Error("connect ECONNREFUSED 10.1.2.3:5432")) },
    });
    const response = await handleSubmitLead(leadRequest(wirePayload({}, (n += 1))), broken);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("internal_error");
    expect(text).not.toContain("ECONNREFUSED");
  });
});

describe("POST /api/v1/postcodes/check", () => {
  const deps = () => ({
    postcodes: createPostcodeService(t.db),
    reference: createReferenceDataProvider(t.db, { ttlMs: 0 }),
    verticalSlug: "electrical",
    logger: silentLogger,
    ipConfig: { mode: "forwarded", trustedHops: 1 } as const,
    allowedOrigins: [ORIGIN],
    rateLimiter: new SlidingWindowRateLimiter({ limit: 100, windowMs: 60_000 }),
  });

  function check(postcode: unknown, headers: Record<string, string> = {}): Request {
    return new Request(`${ORIGIN}/api/v1/postcodes/check`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify({ postcode }),
    });
  }

  async function data(postcode: unknown) {
    const response = await handleCheckPostcode(check(postcode), deps());
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: Record<string, unknown> }).data;
  }

  it("confirms coverage with the area name, and does not leak coordinates", async () => {
    expect(await data("br6 0aa")).toEqual({ status: "covered", postcode: "BR6 0AA", areaName: "Orpington" });
    expect(await data("TN13 1AA")).toEqual({ status: "covered", postcode: "TN13 1AA", areaName: "Sevenoaks and Swanley" });
  });

  it("distinguishes outside the footprint, unknown inside it, and malformed", async () => {
    expect(await data("SW1A 1AA")).toEqual({ status: "out_of_area" });
    expect(await data("BR6 9ZZ")).toEqual({ status: "not_found" });
    expect(await data("hello")).toEqual({ status: "invalid_format" });
  });

  it("does not accept a terminated postcode for a new enquiry, but keeps it so an old lead still resolves", async () => {
    await t.admin.insertInto("postcodes").values({ postcode: "BR6 9QQ", lat: 51.36, lng: 0.1, source: "test", terminated_on: new Date("2007-04-01") }).onConflict((oc) => oc.doNothing()).execute();
    expect(await data("BR6 9QQ")).toEqual({ status: "not_found" });
    expect(await t.admin.selectFrom("postcodes").select("postcode").where("postcode", "=", "BR6 9QQ").execute()).toHaveLength(1);
  });

  it("rejects malformed requests and foreign origins", async () => {
    expect((await handleCheckPostcode(check(12345), deps())).status).toBe(400);
    expect((await handleCheckPostcode(check("BR6 0AA", { origin: "https://evil.example" }), deps())).status).toBe(403);
  });

  it("is rate limited per client", async () => {
    const limited = { ...deps(), rateLimiter: new SlidingWindowRateLimiter({ limit: 2, windowMs: 60_000 }) };
    const ip = { "x-forwarded-for": "198.51.100.77" };
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await handleCheckPostcode(check("BR6 0AA", ip), limited)).status);
    expect(statuses).toEqual([200, 200, 429]);
  });
});

describe("health and readiness", () => {
  it("liveness needs nothing", async () => {
    expect(await handleHealth().json()).toEqual({ status: "ok" });
  });

  it("is ready when the database, postcode directory and consent archive are all in place", async () => {
    const response = await handleReady({ db: t.db, consent: buildConsent("SparkQuote Local"), logger: silentLogger });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { database: "ok", postcodes: "ok", consent: "ok" } });
  });

  it("is NOT ready when the consent wording in code disagrees with the archive (e.g. a changed brand name)", async () => {
    const response = await handleReady({ db: t.db, consent: buildConsent("Some Other Brand"), logger: silentLogger });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { checks: Record<string, string> }).checks.consent).toBe("fail");
  });

  it("is NOT ready when the postcode directory has not been loaded", async () => {
    const empty = await createTestDatabase();
    try {
      await empty.admin.deleteFrom("postcodes").execute();
      const response = await handleReady({ db: empty.db, consent: buildConsent("SparkQuote Local"), logger: silentLogger });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { checks: Record<string, string> }).checks).toEqual({ database: "ok", postcodes: "fail", consent: "ok" });
    } finally {
      await empty.destroy();
    }
  });
});
