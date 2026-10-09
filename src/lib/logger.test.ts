import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";

function capture() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { lines, logger: createLogger({ level: "info", destination }) };
}

describe("logger redaction (a seat belt: the real rule is to not log personal data at all)", () => {
  it("redacts personal fields at the top level and one level down", () => {
    const { logger, lines } = capture();
    logger.info(
      {
        phone: "+447123456789",
        email: "private@example.com",
        name: "Private Person",
        notes: "front door code 1234",
        ip: "203.0.113.9",
        postcode: "BR6 0AA",
        turnstileToken: "tok_secret",
        lead: { phone: "+447123456780", email: "nested@example.com", fullName: "Nested Person" },
        leadId: "keep-me",
      },
      "something happened",
    );
    const output = lines.join("");
    for (const secret of ["+447123456789", "private@example.com", "Private Person", "front door code", "203.0.113.9", "BR6 0AA", "tok_secret", "+447123456780", "nested@example.com", "Nested Person"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("[redacted]");
    expect(output).toContain("keep-me"); // non-personal fields survive
    expect(output).toContain("something happened");
  });

  it("redacts credentials in headers", () => {
    const { logger, lines } = capture();
    logger.info({ req: { headers: { authorization: "Bearer abc.def", cookie: "session=xyz" } } });
    expect(lines.join("")).not.toMatch(/abc\.def|session=xyz/);
  });

  it("overwrites err.detail so a database error cannot log the row", () => {
    const { logger, lines } = capture();
    const error = Object.assign(new Error("duplicate key"), { code: "23505", detail: "Key (email)=(private.person@example.com) already exists." });
    logger.error({ err: error }, "db failed");
    const output = lines.join("");
    expect(output).not.toContain("private.person@example.com");
    expect(output).toContain("[redacted]");
    expect(output).toContain("23505");
  });

  it("emits one JSON object per line with a readable level", () => {
    const { logger, lines } = capture();
    logger.warn({ code: "x" }, "careful");
    const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    expect(parsed).toMatchObject({ level: "warn", code: "x", msg: "careful", service: "leadgen-web" });
  });

  it("falls back to info for an unknown level instead of throwing", () => {
    expect(() => createLogger({ level: "loud" })).not.toThrow();
  });
});
