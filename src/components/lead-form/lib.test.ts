import { describe, expect, it, vi } from "vitest";
import { ApiError, submitLead, type SubmitPayload } from "./api";
import { captureAttribution } from "./attribution";
import { describeFailure } from "./failure";
import { buildPayload } from "./payload";
import { EMPTY_VALUES, type FormValues } from "./state";
import { uuidv4 } from "./uuid";

const payload: SubmitPayload = {
  service: "fault_repair",
  postcode: "BR6 0AA",
  propertyType: "house",
  ownership: "owner",
  scope: "no_power",
  urgency: "emergency",
  contact: { name: "Alex", phone: "07123 456789", email: "a@example.com", notes: "" },
  consent: { accepted: true, textVersion: "v1" },
  context: { elapsedMs: 1, honeypot: "", pagePath: "/", attribution: {} },
};

function json(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, ...init });
}

const noSleep = { sleep: async () => undefined, random: () => 0 };

describe("submitLead", () => {
  it("sends the idempotency key and returns the reference", async () => {
    const fetchImpl = vi.fn(async () => json({ data: { reference: "L-AAAAA-BBBBB" } }, { status: 201 }));
    const result = await submitLead(payload, "key-1", { fetchImpl, ...noSleep });
    expect(result).toEqual({ reference: "L-AAAAA-BBBBB" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/leads");
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("retries network failures and 5xx with the SAME key, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json({ error: { code: "internal_error" } }, { status: 503 }))
      .mockResolvedValueOnce(json({ data: { reference: "L-AAAAA-BBBBB" } }, { status: 200 }));
    const result = await submitLead(payload, "key-7", { fetchImpl, ...noSleep });
    expect(result.reference).toBe("L-AAAAA-BBBBB");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const keys = fetchImpl.mock.calls.map((call) => (call[1].headers as Record<string, string>)["idempotency-key"]);
    expect(new Set(keys)).toEqual(new Set(["key-7"]));
  });

  it("gives up after the attempt limit with a network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("offline"));
    await expect(submitLead(payload, "k", { fetchImpl, ...noSleep })).rejects.toMatchObject({ code: "network_error", status: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry decisions: validation, challenge, conflict and consent errors surface immediately", async () => {
    for (const [status, code] of [[422, "validation_failed"], [403, "challenge_failed"], [409, "consent_outdated"], [409, "idempotency_key_reuse"], [400, "invalid_json"]] as const) {
      const fetchImpl = vi.fn(async () => json({ error: { code, message: "m", fields: { postcode: "p" }, requestId: "r1" } }, { status }));
      await expect(submitLead(payload, "k", { fetchImpl, ...noSleep })).rejects.toMatchObject({ status, code, requestId: "r1" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("honours a short Retry-After on 429 and gives up on a long one", async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => void sleeps.push(ms);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(json({ data: { reference: "L-AAAAA-BBBBB" } }));
    await submitLead(payload, "k", { fetchImpl, sleep, random: () => 0 });
    expect(sleeps[0]).toBeGreaterThanOrEqual(2_000);

    const long = vi.fn(async () => json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "60" } }));
    await expect(submitLead(payload, "k", { fetchImpl: long, ...noSleep })).rejects.toMatchObject({ code: "rate_limited" });
    expect(long).toHaveBeenCalledTimes(1);
  });

  it("treats a 2xx without a reference as a failure, not a success", async () => {
    const fetchImpl = vi.fn(async () => json({ data: {} }));
    await expect(submitLead(payload, "k", { fetchImpl, ...noSleep })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("aborts a hung request after the timeout and retries", async () => {
    let calls = 0;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return Promise.resolve(json({ data: { reference: "L-AAAAA-BBBBB" } }));
    }) as unknown as typeof fetch;
    const result = await submitLead(payload, "k", { fetchImpl, timeoutMs: 20, ...noSleep });
    expect(result.reference).toBe("L-AAAAA-BBBBB");
    expect(calls).toBe(2);
  });
});

describe("describeFailure", () => {
  it("routes validation errors to the field and step that need fixing", () => {
    const failure = describeFailure(new ApiError(422, "validation_failed", "m", { "contact.phone": "Bad phone", urgency: "Pick one" }));
    expect(failure.fieldErrors).toEqual({ phone: "Bad phone", urgency: "Pick one" });
    expect(failure.goToStep).toBe(4);
    expect(failure.formError).toBeNull();
  });

  it("points an out-of-area rejection at the postcode step", () => {
    const failure = describeFailure(new ApiError(422, "out_of_area", "m", { postcode: "We don't cover that area yet." }));
    expect(failure).toMatchObject({ goToStep: 1, fieldErrors: { postcode: "We don't cover that area yet." } });
  });

  it.each([
    ["challenge_failed", 403, /verify you're human/],
    ["rate_limited", 429, /wait a minute/],
    ["network_error", 0, /answers are saved/],
    ["internal_error", 500, /our side/],
  ] as const)("explains %s in plain language and resets the single-use challenge", (code, status, message) => {
    const failure = describeFailure(new ApiError(status, code, "m"));
    expect(failure.formError).toMatch(message);
    expect(failure.resetChallenge).toBe(true);
  });

  it("includes the request id so support can find the failure in the logs", () => {
    expect(describeFailure(new ApiError(500, "internal_error", "m", undefined, undefined, "req-abc")).formError).toContain("req-abc");
  });

  it("asks for a reload when the consent wording changed", () => {
    expect(describeFailure(new ApiError(409, "consent_outdated", "m")).needsReload).toBe(true);
  });

  it("handles non-API errors", () => {
    expect(describeFailure(new Error("boom")).formError).toMatch(/try again/);
  });
});

describe("buildPayload", () => {
  const values: FormValues = {
    ...EMPTY_VALUES,
    service: "fault_repair",
    postcode: " br6 0aa ",
    propertyType: "house",
    ownership: "owner",
    scope: "no_power",
    urgency: "emergency",
    name: "Alex",
    phone: "07123 456789",
    email: "A@Example.com",
    notes: "hi",
  };
  const extras = { turnstileToken: "tok", honeypot: "", consentVersion: "v1", elapsedMs: 12_345.6, pagePath: "/", attribution: { gclid: "g" } };

  it("sends answers as typed (the server normalises) plus consent and telemetry", () => {
    expect(buildPayload(values, extras)).toEqual({
      service: "fault_repair",
      postcode: " br6 0aa ",
      propertyType: "house",
      ownership: "owner",
      scope: "no_power",
      urgency: "emergency",
      contact: { name: "Alex", phone: "07123 456789", email: "A@Example.com", notes: "hi" },
      consent: { accepted: true, textVersion: "v1" },
      context: { elapsedMs: 12_346, turnstileToken: "tok", honeypot: "", pagePath: "/", attribution: { gclid: "g" } },
    });
  });

  it("omits the token when there is none and refuses incomplete forms", () => {
    expect(buildPayload(values, { ...extras, turnstileToken: undefined }).context).not.toHaveProperty("turnstileToken");
    expect(() => buildPayload({ ...values, urgency: null }, extras)).toThrow(/incomplete/);
  });
});

describe("captureAttribution", () => {
  it("reads campaign parameters and click ids from the URL, the path and the referrer host only", () => {
    const result = captureAttribution(
      { search: "?utm_source=google&utm_medium=cpc&utm_campaign=21&gclid=abc&fbclid=&other=1", pathname: "/electrical" },
      "https://www.google.com/search?q=electrician+near+me",
    );
    expect(result).toEqual({ utmSource: "google", utmMedium: "cpc", utmCampaign: "21", gclid: "abc", landingPath: "/electrical", referrerHost: "www.google.com" });
  });

  it("tolerates no parameters and an unparseable referrer", () => {
    expect(captureAttribution({ search: "", pathname: "/" }, "not a url")).toEqual({ landingPath: "/" });
  });
});

describe("uuidv4", () => {
  it("produces valid v4 UUIDs, with the fallback path too", () => {
    const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(uuidv4()).toMatch(pattern);
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      const ids = new Set(Array.from({ length: 50 }, uuidv4));
      expect(ids.size).toBe(50);
      for (const id of ids) expect(id).toMatch(pattern);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});
