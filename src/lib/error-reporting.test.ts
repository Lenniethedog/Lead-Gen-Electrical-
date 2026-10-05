import type { ErrorEvent } from "@sentry/node";
import { afterAll, describe, expect, it } from "vitest";
import { getErrorReporter, initErrorReporting, scrubEvent, scrubText } from "./error-reporting";
import { createLogger, setLogErrorSink } from "./logger";

describe("scrubText", () => {
  it.each([
    ["duplicate key for owner@example.com", "duplicate key for [email]"],
    ["call 07911 123456 now", "call [phone] now"],
    ["call +44 7911 123456 now", "call [phone] now"],
    ["call 020 7946 0123 now", "call [phone] now"],
    ["postcode BR6 0AA failed", "postcode [postcode] failed"],
    ["postcode br60aa failed", "postcode [postcode] failed"],
    ["lead L-ABCDE-FGHJK has attempt 3 and status 503", "lead L-ABCDE-FGHJK has attempt 3 and status 503"],
  ])("%s", (input, expected) => {
    expect(scrubText(input)).toBe(expected);
  });
});

describe("scrubEvent", () => {
  it("removes request, user, breadcrumb and extra data and masks what remains", () => {
    const event = {
      message: "failed for jane@example.com",
      request: { url: "https://x.test/?phone=07911123456", headers: { cookie: "secret" }, data: { name: "Jane" } },
      user: { email: "jane@example.com", ip_address: "1.2.3.4" },
      breadcrumbs: [{ message: "POST /api/v1/leads" }],
      extra: { body: "Jane, 07911 123456" },
      tags: { log_message: "no row for 07911 123456" },
      exception: {
        values: [
          {
            type: "Error",
            value: "bad contact jane@example.com BR6 0AA",
            stacktrace: { frames: [{ function: "f", vars: { phone: "07911123456" } }] },
          },
        ],
      },
    } as unknown as ErrorEvent;
    const clean = scrubEvent(event);
    expect(clean.request).toBeUndefined();
    expect(clean.user).toBeUndefined();
    expect(clean.breadcrumbs).toBeUndefined();
    expect(clean.extra).toBeUndefined();
    expect(clean.message).toBe("failed for [email]");
    expect(clean.tags).toEqual({ log_message: "no row for [phone]" });
    expect(clean.exception?.values?.[0]?.value).toBe("bad contact [email] [postcode]");
    expect(clean.exception?.values?.[0]?.stacktrace?.frames?.[0]).not.toHaveProperty("vars");
    expect(JSON.stringify(clean)).not.toMatch(/jane|07911|0AA|cookie/i);
  });
});

describe("when no DSN is configured", () => {
  it("is a silent no-op and never loads the SDK", async () => {
    const reporter = await initErrorReporting({ dsn: undefined, environment: "development", service: "leadgen-web" });
    expect(reporter.enabled).toBe(false);
    reporter.captureException(new Error("x"));
    reporter.captureMessage("y");
    expect(await reporter.flush()).toBe(true);
    expect(getErrorReporter()).toBe(reporter);
  });
});

describe("with the real Sentry SDK and a capturing transport (what would leave the process)", () => {
  const sent: string[] = [];
  afterAll(() => setLogErrorSink(undefined));

  /** The envelope is newline-delimited JSON; the event is the third line. */
  const eventsSent = () =>
    sent
      .map((body) => body.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>))
      .map((lines) => lines.find((line) => "exception" in line || "message" in line))
      .filter((event): event is Record<string, unknown> => event !== undefined);

  it("sends an error with only the whitelisted tags and no personal data, even if the error message contains some", async () => {
    const reporter = await initErrorReporting({
      dsn: "https://publickey@o0.ingest.sentry.io/1",
      environment: "test",
      service: "leadgen-worker",
      transport: async ({ body }) => void sent.push(typeof body === "string" ? body : new TextDecoder().decode(body)),
    });
    expect(reporter.enabled).toBe(true);

    const logger = createLogger({ level: "error", service: "leadgen-worker", destination: { write: () => undefined } });
    logger.error(
      {
        err: new Error("insert failed for owner@example.com 07911 123456 at BR6 0AA"),
        alertId: "11111111-1111-1111-1111-111111111111",
        leadId: "22222222-2222-2222-2222-222222222222",
        // None of these may ever be forwarded:
        phone: "07911 123456",
        email: "owner@example.com",
        notes: "gate code 4821",
        body: { name: "Jane Doe" },
      },
      "operator alert processing failed",
    );
    logger.error("plain message with jane@example.com");
    await reporter.flush(5_000);

    const events = eventsSent();
    expect(events.length).toBeGreaterThanOrEqual(2);
    const everything = JSON.stringify(events);
    for (const secret of ["owner@example.com", "jane@example.com", "07911", "123456", "BR6 0AA", "gate code", "4821", "Jane Doe"]) {
      expect(everything, `leaked ${secret}`).not.toContain(secret);
    }
    const withTags = events.find((event) => (event.tags as Record<string, string> | undefined)?.alertId);
    expect(withTags?.tags).toMatchObject({
      alertId: "11111111-1111-1111-1111-111111111111",
      leadId: "22222222-2222-2222-2222-222222222222",
      service: "leadgen-worker",
    });
    for (const event of events) {
      expect(event).not.toHaveProperty("request");
      expect(event).not.toHaveProperty("user");
      expect(event).not.toHaveProperty("breadcrumbs");
    }
  });

  it("does not report warnings or info lines", async () => {
    const before = sent.length;
    const logger = createLogger({ level: "debug", destination: { write: () => undefined } });
    logger.warn({ alertId: "x" }, "operator alert failed, will retry");
    logger.info("hello");
    await getErrorReporter().flush(2_000);
    expect(sent.length).toBe(before);
  });
});
