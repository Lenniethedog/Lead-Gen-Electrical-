import { describe, expect, it, vi } from "vitest";
import { FRAUD_THRESHOLDS, SIGNAL_WEIGHTS, type FraudSignalCode } from "@/config/fraud";
import { assess, collectRequestSignals, createTurnstileVerifier, decisionForScore, signal } from "./index";
import type { RequestSignalInput } from "./index";

const clean: RequestSignalInput = {
  honeypot: "",
  elapsedMs: 45_000,
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  country: "GB",
  challenge: { status: "passed" },
  name: "Alex Example",
  email: "alex@example.com",
  phoneKind: "mobile",
  notes: undefined,
};

function codes(overrides: Partial<RequestSignalInput>): string[] {
  return collectRequestSignals({ ...clean, ...overrides }).map((item) => item.code);
}

describe("decisionForScore thresholds", () => {
  it.each([
    [0, "accept"],
    [FRAUD_THRESHOLDS.flag - 1, "accept"],
    [FRAUD_THRESHOLDS.flag, "flag"],
    [FRAUD_THRESHOLDS.review - 1, "flag"],
    [FRAUD_THRESHOLDS.review, "review"],
    [FRAUD_THRESHOLDS.reject - 1, "review"],
    [FRAUD_THRESHOLDS.reject, "reject"],
    [100, "reject"],
  ])("score %i -> %s", (score, decision) => {
    expect(decisionForScore(score)).toBe(decision);
  });
});

describe("assess", () => {
  it("scores a clean submission as accept with no signals", () => {
    expect(assess(collectRequestSignals(clean))).toEqual({ score: 0, decision: "accept", signals: [] });
  });

  it("counts each signal code once, however often it is reported", () => {
    const result = assess([signal("voip_phone"), signal("voip_phone"), signal("voip_phone")]);
    expect(result.score).toBe(SIGNAL_WEIGHTS.voip_phone);
    expect(result.signals).toHaveLength(1);
  });

  it("caps the score at 100", () => {
    const everything = (Object.keys(SIGNAL_WEIGHTS) as FraudSignalCode[]).map((code) => signal(code));
    expect(assess(everything).score).toBe(100);
  });

  it("combines weak signals into a flag/review without any single one doing so", () => {
    expect(assess([signal("disposable_email"), signal("non_uk_country")]).decision).toBe("flag");
    expect(assess([signal("disposable_email"), signal("completed_quickly")]).decision).toBe("review");
  });
});

describe("calibration principles", () => {
  const weak: FraudSignalCode[] = [
    "turnstile_unavailable",
    "ip_velocity_elevated",
    "voip_phone",
    "non_uk_country",
    "completed_quickly",
  ];

  it.each(weak)("weak signal %s alone never costs a lead (stays below the flag threshold)", (code) => {
    expect(assess([signal(code)]).decision).toBe("accept");
  });

  it.each<FraudSignalCode>(["honeypot_filled", "blocklisted_identifier"])("%s alone rejects", (code) => {
    expect(assess([signal(code)]).decision).toBe("reject");
  });

  it("holds (does not reject) when the browser was automated or the challenge was skipped", () => {
    expect(assess([signal("automation_user_agent")]).decision).toBe("review");
    expect(assess([signal("turnstile_missing")]).decision).toBe("review");
    expect(assess([signal("completed_too_fast")]).decision).toBe("review");
  });
});

describe("collectRequestSignals", () => {
  it("flags a filled honeypot (whitespace-only does not count)", () => {
    expect(codes({ honeypot: "http://spam.example" })).toContain("honeypot_filled");
    expect(codes({ honeypot: "   " })).not.toContain("honeypot_filled");
    expect(codes({ honeypot: undefined })).not.toContain("honeypot_filled");
  });

  it("flags automation clients and a missing user agent", () => {
    for (const userAgent of ["curl/8.7.1", "python-requests/2.31", "Mozilla/5.0 HeadlessChrome/120", "Go-http-client/1.1", "node-fetch/3"]) {
      expect(codes({ userAgent })).toContain("automation_user_agent");
    }
    expect(codes({ userAgent: null })).toContain("automation_user_agent");
  });

  it("grades completion speed", () => {
    expect(codes({ elapsedMs: 800 })).toEqual(["completed_too_fast"]);
    expect(codes({ elapsedMs: 4_999 })).toEqual(["completed_too_fast"]);
    expect(codes({ elapsedMs: 5_000 })).toEqual(["completed_quickly"]);
    expect(codes({ elapsedMs: 9_999 })).toEqual(["completed_quickly"]);
    expect(codes({ elapsedMs: 10_000 })).toEqual([]);
  });

  it("reflects the challenge outcome", () => {
    expect(codes({ challenge: { status: "missing" } })).toEqual(["turnstile_missing"]);
    expect(codes({ challenge: { status: "unavailable", reason: "http_500" } })).toEqual(["turnstile_unavailable"]);
    expect(codes({ challenge: { status: "passed" } })).toEqual([]);
  });

  it("flags disposable email domains and VoIP numbers", () => {
    expect(codes({ email: "x@mailinator.com" })).toContain("disposable_email");
    expect(codes({ email: "x@gmail.com" })).not.toContain("disposable_email");
    expect(codes({ phoneKind: "voip" })).toContain("voip_phone");
  });

  it("flags placeholder and keyboard-mash names", () => {
    for (const name of ["Test", "asdf", "John Doe", "  QWERTY ", "aaaa", "xxx"]) {
      expect(codes({ name })).toContain("placeholder_name");
    }
    expect(codes({ name: "Alex Example" })).not.toContain("placeholder_name");
  });

  it("flags links in the free text", () => {
    expect(codes({ notes: "see http://spam.example for details" })).toContain("url_in_notes");
    expect(codes({ notes: "WWW.spam.example" })).toContain("url_in_notes");
    expect(codes({ notes: "The kitchen lights keep tripping the fuse board" })).not.toContain("url_in_notes");
  });

  it("treats Tor, foreign countries and unknown countries differently", () => {
    expect(codes({ country: "T1" })).toEqual(["tor_exit_node"]);
    expect(codes({ country: "DE" })).toEqual(["non_uk_country"]);
    expect(codes({ country: "GB" })).toEqual([]);
    expect(codes({ country: "XX" })).toEqual([]);
    expect(codes({ country: null })).toEqual([]);
  });

  it("never puts personal data in signal evidence", () => {
    const evidence = JSON.stringify(
      collectRequestSignals({
        ...clean,
        email: "private.person@mailinator.com",
        name: "Test",
        notes: "see http://x.example",
        userAgent: "curl/8",
      }),
    );
    expect(evidence).not.toContain("private.person");
    expect(evidence).not.toContain("x.example");
  });
});

describe("createTurnstileVerifier", () => {
  const input = { token: "tok", ip: "203.0.113.7", idempotencyKey: "key-1" };

  function respond(body: unknown, init: ResponseInit = { status: 200 }) {
    return vi.fn(async () => new Response(JSON.stringify(body), init));
  }

  it("passes a valid token and sends the secret, token, client IP and idempotency key", async () => {
    const fetchImpl = respond({ success: true });
    const result = await createTurnstileVerifier({ secret: "s3cret", fetchImpl }).verify(input);
    expect(result).toEqual({ status: "passed" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(init.body as URLSearchParams);
    expect(Object.fromEntries(body)).toEqual({
      secret: "s3cret",
      response: "tok",
      remoteip: "203.0.113.7",
      idempotency_key: "key-1",
    });
  });

  it("omits remoteip when the client address is unknown", async () => {
    const fetchImpl = respond({ success: true });
    await createTurnstileVerifier({ secret: "s", fetchImpl }).verify({ ...input, ip: null });
    const body = new URLSearchParams((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams);
    expect(body.has("remoteip")).toBe(false);
  });

  it("reports a missing token without calling Cloudflare", async () => {
    const fetchImpl = respond({ success: true });
    const verifier = createTurnstileVerifier({ secret: "s", fetchImpl });
    expect(await verifier.verify({ ...input, token: undefined })).toEqual({ status: "missing" });
    expect(await verifier.verify({ ...input, token: "   " })).toEqual({ status: "missing" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([["invalid-input-response"], ["timeout-or-duplicate"]])("fails (retryable) on a bad token: %s", async (code) => {
    const result = await createTurnstileVerifier({ secret: "s", fetchImpl: respond({ success: false, "error-codes": [code] }) }).verify(input);
    expect(result).toEqual({ status: "failed", codes: [code] });
  });

  it("fails OPEN, not closed, when the problem is ours or Cloudflare's", async () => {
    const verifier = (fetchImpl: typeof fetch) => createTurnstileVerifier({ secret: "s", fetchImpl });

    const badSecret = await verifier(respond({ success: false, "error-codes": ["invalid-input-secret"] })).verify(input);
    expect(badSecret).toEqual({ status: "unavailable", reason: "invalid-input-secret" });

    const internal = await verifier(respond({ success: false, "error-codes": ["internal-error"] })).verify(input);
    expect(internal.status).toBe("unavailable");

    const http500 = await verifier(respond({}, { status: 500 })).verify(input);
    expect(http500).toEqual({ status: "unavailable", reason: "http_500" });

    const network = await verifier(vi.fn(async () => Promise.reject(new TypeError("fetch failed")))).verify(input);
    expect(network).toEqual({ status: "unavailable", reason: "TypeError" });

    const garbage = await verifier(vi.fn(async () => new Response("<html>", { status: 200 }))).verify(input);
    expect(garbage).toEqual({ status: "unavailable", reason: "invalid_response" });
  });

  it("times out instead of hanging a lead submission on a slow Cloudflare", async () => {
    const hang = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;
    const started = Date.now();
    const result = await createTurnstileVerifier({ secret: "s", fetchImpl: hang, timeoutMs: 50 }).verify(input);
    expect(result.status).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
