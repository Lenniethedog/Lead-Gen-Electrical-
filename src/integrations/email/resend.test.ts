import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startFakeResend, type FakeResend } from "../../../tests/helpers/fake-resend";
import { createConsoleSender } from "./console";
import { createEmailSender } from "./index";
import { createResendSender } from "./resend";

let fake: FakeResend;
beforeEach(async () => {
  fake = await startFakeResend();
});
afterEach(async () => {
  await fake.close();
});

const message = {
  to: ["owner@example.com", "ops@example.com"],
  subject: "[Brand] New lead L-ABCDE-FGHJK",
  text: "body",
  idempotencyKey: "operator-alert-123",
};
const sender = () => createResendSender({ apiKey: "re_test_key_123", from: "Brand <alerts@mail.example.com>", baseUrl: fake.url });
const signal = (ms = 2_000) => AbortSignal.timeout(ms);

describe("createResendSender", () => {
  it("posts the documented request with the alert's stable idempotency key", async () => {
    const result = await sender().send(message, { signal: signal() });
    expect(result).toEqual({ outcome: "accepted", providerMessageId: "email_1" });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "POST",
      path: "/emails",
      authorization: "Bearer re_test_key_123",
      idempotencyKey: "operator-alert-123",
      body: { from: "Brand <alerts@mail.example.com>", to: ["owner@example.com", "ops@example.com"], subject: message.subject, text: "body" },
    });
  });

  it("sends nothing but those four fields (no tracking, no html, no attachments)", async () => {
    await sender().send(message, { signal: signal() });
    expect(Object.keys(fake.requests[0]!.body).sort()).toEqual(["from", "subject", "text", "to"]);
  });

  it("a retry with the same key is answered with the original result and delivers nothing new", async () => {
    const first = await sender().send(message, { signal: signal() });
    const again = await sender().send(message, { signal: signal() });
    expect(again).toEqual(first);
    expect(fake.requests).toHaveLength(2);
    expect(fake.delivered).toHaveLength(1);
  });

  it("reusing a key with a DIFFERENT payload is a 409 invalid_idempotent_request, reported with that exact code so the alert service can rotate the key", async () => {
    await sender().send(message, { signal: signal() });
    const changed = await sender().send({ ...message, to: [...message.to, "third@example.com"] }, { signal: signal() });
    expect(changed).toEqual({ outcome: "retryable_failure", errorCode: "invalid_idempotent_request", httpStatus: 409 });
    expect(fake.delivered).toHaveLength(1); // nothing new was sent
    // A fresh key with the changed payload goes through.
    const rotated = await sender().send({ ...message, to: [...message.to, "third@example.com"], idempotencyKey: `${message.idempotencyKey}-r3` }, { signal: signal() });
    expect(rotated.outcome).toBe("accepted");
    expect(fake.delivered).toHaveLength(2);
  });

  it.each([
    [429, "rate_limit_exceeded"],
    [500, "application_error"],
    [503, "http_503"],
    [408, "http_408"],
    [409, "concurrent_idempotent_requests"],
  ])("treats HTTP %i as retryable", async (status, name) => {
    fake.queue({ status, body: name.startsWith("http_") ? {} : { statusCode: status, name, message: "x" } });
    const result = await sender().send(message, { signal: signal() });
    expect(result).toEqual({ outcome: "retryable_failure", errorCode: name, httpStatus: status });
  });

  it.each([401, 403])("treats HTTP %i (credentials or an unverified domain) as retryable, since it can be fixed in minutes", async (status) => {
    fake.queue({ status, body: { statusCode: status, name: "restricted_api_key", message: "x" } });
    const result = await sender().send(message, { signal: signal() });
    expect(result).toMatchObject({ outcome: "retryable_failure", errorCode: "restricted_api_key", httpStatus: status });
  });

  it.each([400, 404, 422])("treats HTTP %i as permanent: retrying the same request cannot help", async (status) => {
    fake.queue({ status, body: { statusCode: status, name: "validation_error", message: "x" } });
    const result = await sender().send(message, { signal: signal() });
    expect(result).toEqual({ outcome: "permanent_failure", errorCode: "validation_error", httpStatus: status });
  });

  it("does not follow redirects and reports them as permanent", async () => {
    fake.queue({ status: 302, body: {} });
    const result = await sender().send(message, { signal: signal() });
    expect(result).toMatchObject({ outcome: "permanent_failure", httpStatus: 302 });
  });

  it("sanitises the provider's error name before it is stored or logged", async () => {
    fake.queue({ status: 422, body: { name: "Bad Address <owner@example.com>!!", message: "echoes owner@example.com" } });
    const result = await sender().send(message, { signal: signal() });
    expect(result.outcome).toBe("permanent_failure");
    if (result.outcome === "permanent_failure") {
      expect(result.errorCode).toMatch(/^[a-z0-9_]+$/);
      expect(result.errorCode.length).toBeLessThanOrEqual(60);
    }
  });

  it("falls back to a status-based code when the error body is not JSON", async () => {
    fake.queue({ status: 500, body: "<html>Bad gateway</html>" });
    const result = await sender().send(message, { signal: signal() });
    expect(result).toMatchObject({ outcome: "retryable_failure", httpStatus: 500 });
  });

  it("reports a provider that never answers as a retryable timeout instead of hanging", async () => {
    fake.queue({ hang: true, status: 200 });
    const started = performance.now();
    const result = await sender().send(message, { signal: signal(150) });
    expect(result).toEqual({ outcome: "retryable_failure", errorCode: "timeout" });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("reports an unreachable provider as a retryable network error", async () => {
    await fake.close();
    const result = await sender().send(message, { signal: signal() });
    expect(result).toEqual({ outcome: "retryable_failure", errorCode: "network_error" });
    fake = await startFakeResend(); // so afterEach has something to close
  });

  it("accepts a success response without an id", async () => {
    fake.queue({ status: 200, body: {} });
    expect(await sender().send(message, { signal: signal() })).toEqual({ outcome: "accepted" });
  });
});

describe("createConsoleSender and the factory", () => {
  it("prints the message and reports it accepted", async () => {
    const lines: string[] = [];
    const result = await createConsoleSender((line) => lines.push(line)).send(message, { signal: signal() });
    expect(result.outcome).toBe("accepted");
    expect(lines.join("\n")).toContain("subject: [Brand] New lead L-ABCDE-FGHJK");
  });

  const workerEnv = (overrides: Record<string, unknown>) =>
    ({ APP_ENV: "development", EMAIL_PROVIDER: "console", ...overrides }) as Parameters<typeof createEmailSender>[0];

  it("refuses the console provider where it could hide a missing alert", () => {
    expect(() => createEmailSender(workerEnv({ APP_ENV: "production" }))).toThrow(/not allowed in production/);
    expect(() => createEmailSender(workerEnv({ APP_ENV: "staging" }))).toThrow(/not allowed in staging/);
    expect(createEmailSender(workerEnv({}))).toBeDefined();
  });

  it("builds the Resend sender only when it is fully configured", () => {
    expect(() => createEmailSender(workerEnv({ EMAIL_PROVIDER: "resend" }))).toThrow(/RESEND_API_KEY/);
    expect(createEmailSender(workerEnv({ EMAIL_PROVIDER: "resend", RESEND_API_KEY: "re_abcdefgh", EMAIL_FROM: "A <a@b.co>" }))).toBeDefined();
  });
});
