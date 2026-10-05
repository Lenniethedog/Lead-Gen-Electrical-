import pino from "pino";
import { describe, expect, it } from "vitest";
import { AppError, ValidationError } from "./errors";
import { assertAllowedOrigin, buildRequestContext, errorResponse, readJsonBody } from "./http";

const json = { "content-type": "application/json" };
const ipConfig = { mode: "none", trustedHops: 1 } as const;

function post(body: BodyInit | null, headers: Record<string, string> = json): Request {
  return new Request("http://localhost/api", { method: "POST", headers, body });
}

function streamOf(...chunks: Uint8Array[]): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Request("http://localhost/api", { method: "POST", headers: json, body, duplex: "half" } as RequestInit);
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return (error as AppError).code;
  }
  throw new Error("expected rejection");
}

describe("readJsonBody", () => {
  it("parses a JSON body", async () => {
    await expect(readJsonBody(post('{"a":1}'), 1024)).resolves.toEqual({ a: 1 });
  });

  it("accepts a charset parameter", async () => {
    const request = post('{"a":1}', { "content-type": "application/json; charset=utf-8" });
    await expect(readJsonBody(request, 1024)).resolves.toEqual({ a: 1 });
  });

  it("rejects non-JSON content types", async () => {
    expect(await codeOf(readJsonBody(post("a=1", { "content-type": "application/x-www-form-urlencoded" }), 1024))).toBe(
      "unsupported_media_type",
    );
    expect(await codeOf(readJsonBody(post("{}", { "content-type": "text/plain" }), 1024))).toBe("unsupported_media_type");
    expect(await codeOf(readJsonBody(post("{}", {}), 1024))).toBe("unsupported_media_type");
  });

  it("rejects malformed JSON, invalid UTF-8 and empty bodies with specific codes", async () => {
    expect(await codeOf(readJsonBody(post("{not json"), 1024))).toBe("invalid_json");
    expect(await codeOf(readJsonBody(streamOf(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])), 1024))).toBe("invalid_encoding");
    expect(await codeOf(readJsonBody(post(null), 1024))).toBe("empty_body");
  });

  it("enforces the size cap while STREAMING, without trusting Content-Length", async () => {
    const big = new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(600) }));
    // Two chunks, no Content-Length header: the cap must trip mid-stream.
    const half = Math.floor(big.length / 2);
    const request = streamOf(big.slice(0, half), big.slice(half));
    expect(await codeOf(readJsonBody(request, 512))).toBe("payload_too_large");
  });

  it("rejects an oversized declared Content-Length up front", async () => {
    const request = post("{}", { ...json, "content-length": "999999" });
    expect(await codeOf(readJsonBody(request, 1024))).toBe("payload_too_large");
  });
});

describe("assertAllowedOrigin", () => {
  const allowed = ["https://www.example.co.uk"];

  it("allows listed origins and requests without an Origin header (non-browser clients)", () => {
    const withOrigin = new Request("http://x", { headers: { origin: "https://www.example.co.uk" } });
    expect(() => assertAllowedOrigin(withOrigin, allowed)).not.toThrow();
    expect(() => assertAllowedOrigin(new Request("http://x"), allowed)).not.toThrow();
  });

  it("rejects any other origin, including look-alikes and null", () => {
    for (const origin of ["https://evil.example", "https://www.example.co.uk.evil.example", "http://www.example.co.uk", "null"]) {
      expect(() => assertAllowedOrigin(new Request("http://x", { headers: { origin } }), allowed)).toThrowError(
        expect.objectContaining({ code: "forbidden_origin", status: 403 }),
      );
    }
  });
});

describe("assertAllowedOrigin: development any-port entries", () => {
  const allowed = ["https://www.example.co.uk", "http://localhost:*", "http://127.0.0.1:*"];
  const attempt = (origin: string) => () => assertAllowedOrigin(new Request("http://x", { headers: { origin } }), allowed);

  it("allows localhost and 127.0.0.1 on any port", () => {
    for (const origin of ["http://localhost:3000", "http://localhost:3100", "http://127.0.0.1:5173"]) expect(attempt(origin)).not.toThrow();
  });

  it("does not let look-alikes, other schemes or other hosts through", () => {
    for (const origin of ["http://localhost", "https://localhost:3000", "http://localhost:3000.evil.example", "http://localhost.evil.example:3000", "http://localhostx:3000", "http://127x0x0x1:3000", "http://evil.example:3000"]) {
      expect(attempt(origin), origin).toThrowError(expect.objectContaining({ code: "forbidden_origin" }));
    }
  });

  it("is inert without the entry: a plain list still demands an exact match", () => {
    const strict = () => assertAllowedOrigin(new Request("http://x", { headers: { origin: "http://localhost:3999" } }), ["http://localhost:3000"]);
    expect(strict).toThrowError(expect.objectContaining({ code: "forbidden_origin" }));
  });
});

describe("buildRequestContext", () => {
  it("keeps a well-formed incoming request id and replaces anything else", () => {
    const good = new Request("http://x", { headers: { "x-request-id": "abc-123_DEF.456" } });
    expect(buildRequestContext(good, ipConfig).requestId).toBe("abc-123_DEF.456");

    for (const bad of ["short", "has spaces in it!", "line\nbreak-injection-attempt", "x".repeat(200)]) {
      const request = new Request("http://x", { headers: { "x-request-id": bad.replace("\n", " ") } });
      const { requestId } = buildRequestContext(request, ipConfig);
      expect(requestId).not.toBe(bad);
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("truncates the user agent and reports null when absent", () => {
    const long = new Request("http://x", { headers: { "user-agent": "A".repeat(2_000) } });
    expect(buildRequestContext(long, ipConfig).userAgent).toHaveLength(512);
    const none = new Request("http://x");
    expect(buildRequestContext(none, ipConfig).userAgent).toBeNull();
  });

  it("does not trust forwarded headers in mode none", () => {
    const request = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4", "cf-connecting-ip": "5.6.7.8" } });
    expect(buildRequestContext(request, ipConfig).ip).toBeNull();
  });
});

describe("errorResponse", () => {
  const logger = pino({ level: "silent" });

  it("renders AppErrors with their public code, status, fields and headers", async () => {
    const response = errorResponse(new ValidationError({ "contact.phone": "Bad phone" }), { requestId: "req-1", logger });
    expect(response.status).toBe(422);
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "validation_failed",
        message: "Some of the details need attention.",
        fields: { "contact.phone": "Bad phone" },
        requestId: "req-1",
      },
    });
  });

  it("hides the details of unexpected errors", async () => {
    const response = errorResponse(new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"), {
      requestId: "req-2",
      logger,
    });
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("internal_error");
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("hunter2");
  });
});
