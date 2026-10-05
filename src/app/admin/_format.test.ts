import { describe, expect, it } from "vitest";
import { formatShort, isOverdue, mailtoHref, waitingLabel } from "./_format";

const at = (iso: string) => new Date(iso);

describe("waitingLabel", () => {
  const from = at("2026-10-04T12:00:00Z");
  it.each([
    ["2026-10-04T12:00:30Z", "just now"],
    ["2026-10-04T12:01:00Z", "1 min"],
    ["2026-10-04T12:59:59Z", "59 min"],
    ["2026-10-04T13:00:00Z", "1 h"],
    ["2026-10-04T14:05:00Z", "2 h 5 min"],
    ["2026-10-05T12:00:00Z", "1 d"],
    ["2026-10-05T15:00:00Z", "1 d 3 h"],
  ])("%s -> %s", (now, expected) => {
    expect(waitingLabel(from, at(now))).toBe(expected);
  });

  it("never goes negative if clocks disagree", () => {
    expect(waitingLabel(at("2026-10-04T12:05:00Z"), at("2026-10-04T12:00:00Z"))).toBe("just now");
  });
});

describe("formatShort", () => {
  it("renders UK local time (BST in summer, GMT in winter), not the server's timezone", () => {
    expect(formatShort(at("2026-07-01T11:30:00Z"))).toBe("1 Jul, 12:30");
    expect(formatShort(at("2026-12-01T11:30:00Z"))).toBe("1 Dec, 11:30");
  });
});

describe("isOverdue", () => {
  it("turns on after 30 minutes", () => {
    const from = at("2026-10-04T12:00:00Z");
    expect(isOverdue(from, at("2026-10-04T12:30:00Z"))).toBe(false);
    expect(isOverdue(from, at("2026-10-04T12:30:01Z"))).toBe(true);
  });
});

describe("mailtoHref", () => {
  it("leaves an ordinary address readable", () => {
    expect(mailtoHref("jane.o'neil+roofs@example.co.uk")).toBe("mailto:jane.o'neil+roofs@example.co.uk");
  });

  it("encodes anything that could start a mailto header or break out of the URL", () => {
    const href = mailtoHref("a?bcc=evil@x.co&body=hi#frag%0Ax@example.com");
    expect(href).not.toMatch(/[?&#=]/);
    expect(href).toContain("%3F");
    expect(href).toContain("%26");
    expect(href).toContain("%25");
    expect(href.startsWith("mailto:")).toBe(true);
  });
});
