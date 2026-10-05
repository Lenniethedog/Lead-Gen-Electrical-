import { describe, expect, it, vi } from "vitest";
import { buildAlertMessage, type AlertLeadContext } from "./message";

const lead: AlertLeadContext = {
  leadId: "0b6f6b0e-3a0e-4e55-9c63-1b1b6d3f2a11",
  reference: "L-ABCDE-FGHJK",
  serviceLabel: "Roof repair or leak",
  postcodeOutward: "BR6",
  urgency: "within_2_weeks",
  fraudScore: 0,
  fraudDecision: "accept",
  // 11:30 UTC on 1 July is 12:30 in the UK (British Summer Time).
  createdAt: new Date("2026-07-01T11:30:00Z"),
};
const options = {
  brandName: "Kent Roof Match",
  adminBaseUrl: "https://admin.kentroofmatch.co.uk",
  reminderAfterMinutes: 15,
};

describe("buildAlertMessage", () => {
  it("announces a new lead with only what is needed to decide to go and look", () => {
    const { subject, text } = buildAlertMessage("new_lead", lead, options);
    expect(subject).toBe("[Kent Roof Match] New lead L-ABCDE-FGHJK - Roof repair or leak - BR6");
    expect(text).toContain("Reference: L-ABCDE-FGHJK");
    expect(text).toContain("Area:      BR6");
    expect(text).toContain("Timing:    Within 2 weeks");
    expect(text).toContain("Screening: Clear");
    expect(text).toContain("Open the lead:\nhttps://admin.kentroofmatch.co.uk/admin/leads/0b6f6b0e-3a0e-4e55-9c63-1b1b6d3f2a11");
    expect(text).toContain("deliberately contains no contact details");
  });

  it("shows the time in UK local time, not UTC", () => {
    expect(buildAlertMessage("new_lead", lead, options).text).toContain("Received:  1 Jul 2026, 12:30 (UK time)");
  });

  it("marks emergencies as urgent in the subject, where a phone's lock screen will show it", () => {
    const { subject, text } = buildAlertMessage("new_lead", { ...lead, urgency: "emergency" }, options);
    expect(subject.endsWith(" - URGENT")).toBe(true);
    expect(text).toContain("Timing:    Urgent (It's leaking or unsafe right now)");
  });

  it("says a held lead is NOT usable until a human decides, and shows the score", () => {
    const { subject, text } = buildAlertMessage("held_lead", { ...lead, fraudScore: 55, fraudDecision: "review" }, options);
    expect(subject).toContain("Held lead L-ABCDE-FGHJK needs review");
    expect(text).toContain("will not be used until you decide");
    expect(text).toContain("Screened into manual review (score 55)");
  });

  it("flags a borderline lead that was still accepted", () => {
    const { text } = buildAlertMessage("new_lead", { ...lead, fraudScore: 30, fraudDecision: "flag" }, options);
    expect(text).toContain("Flagged (score 30)");
  });

  it("says a reminded lead has waited MORE THAN the configured delay (never an exact, changing wait)", () => {
    const { subject, text } = buildAlertMessage("reminder", lead, options);
    expect(subject).toBe("[Kent Roof Match] Reminder: lead L-ABCDE-FGHJK still waiting (15+ min)");
    expect(text).toContain("waiting more than 15 minutes with no action recorded");
    expect(buildAlertMessage("reminder", lead, { ...options, reminderAfterMinutes: 30 }).subject).toContain("(30+ min)");
  });

  it("cannot be used to inject extra email headers, whatever the inputs contain", () => {
    const hostile = { ...lead, serviceLabel: "Roofing\r\nBcc: attacker@example.com", postcodeOutward: "BR6\nX-Evil: 1" };
    const { subject } = buildAlertMessage("new_lead", hostile, { ...options, brandName: "Brand\r\nCc: x@y.z" });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(subject).toContain("Roofing Bcc: attacker@example.com");
  });

  it("has no way to carry personal data: the input type contains no contact fields", () => {
    // If someone adds name/phone/email/notes to the context type this list stops matching and the
    // test fails, forcing the privacy decision to be made deliberately (docs/04, "Data minimisation").
    expect(Object.keys(lead).sort()).toEqual(
      ["createdAt", "fraudDecision", "fraudScore", "leadId", "postcodeOutward", "reference", "serviceLabel", "urgency"].sort(),
    );
  });
});

describe("determinism: a retry must send EXACTLY the same message (the provider only deduplicates identical payloads)", () => {
  const kinds = ["new_lead", "held_lead", "reminder"] as const;
  // Every branch of the wording: each screening result, urgent and not.
  const variants: Array<[string, AlertLeadContext]> = [
    ["clear", lead],
    ["flagged", { ...lead, fraudDecision: "flag", fraudScore: 30 }],
    ["held for review, urgent", { ...lead, fraudDecision: "review", fraudScore: 55, urgency: "emergency" }],
  ];

  it.each(kinds.flatMap((kind) => variants.map(([name, context]) => [kind, name, context] as const)))(
    "%s / %s: the same inputs give byte-identical output however much time has passed",
    (kind, _name, context) => {
      const first = buildAlertMessage(kind, context, options);
      vi.useFakeTimers();
      try {
        for (const later of ["2026-07-01T11:30:01Z", "2026-07-01T11:46:59Z", "2031-01-01T00:00:00Z"]) {
          vi.setSystemTime(new Date(later));
          expect(buildAlertMessage(kind, context, options)).toEqual(first);
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not depend on anything that changes after the alert is created", () => {
    // The context type deliberately has no `status`; this guards against it (or a wait time) creeping back in.
    expect("status" in lead).toBe(false);
    expect(buildAlertMessage("held_lead", lead, options)).toEqual(buildAlertMessage("held_lead", { ...lead }, options));
  });

  it("reads no clock at all, in any branch", () => {
    const spy = vi.spyOn(Date, "now");
    for (const kind of kinds) for (const [, context] of variants) buildAlertMessage(kind, context, options);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
