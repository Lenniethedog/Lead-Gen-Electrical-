import { describe, expect, it } from "vitest";
import { extractErasedLeadIds } from "./replay";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const line = (entry: Record<string, unknown>) => JSON.stringify({ level: "warn", service: "leadgen-web", ...entry });

describe("extractErasedLeadIds", () => {
  it("finds the lead ids of erasure log lines, once each, ignoring everything else", () => {
    const logs = [
      line({ msg: "lead accepted", leadId: A }),
      line({ msg: "privacy: lead erased", leadId: A, action: "lead_erased", reason: "consumer_request", actor: "staff" }),
      "not json at all",
      line({ msg: "privacy: lead erased", leadId: B }),
      line({ msg: "privacy: lead erased", leadId: A }), // duplicate
      line({ msg: "privacy: consent withdrawn", leadId: B }),
      '{"msg":"privacy: lead erased","leadId":"truncated',
      "",
    ].join("\n");
    expect(extractErasedLeadIds(logs).sort()).toEqual([A, B]);
  });

  it("rejects anything that is not a UUID, so a malformed or hostile log line cannot name arbitrary records", () => {
    const logs = [line({ msg: "privacy: lead erased", leadId: "1 OR 1=1" }), line({ msg: "privacy: lead erased", leadId: 42 }), line({ msg: "privacy: lead erased" }), line({ msg: "privacy: lead erased", leadId: "'; drop table leads;--" })].join("\n");
    expect(extractErasedLeadIds(logs)).toEqual([]);
  });

  it("normalises case and copes with carriage returns and an empty input", () => {
    expect(extractErasedLeadIds(`${line({ msg: "privacy: lead erased", leadId: A.toUpperCase() })}\r\n`)).toEqual([A]);
    expect(extractErasedLeadIds("")).toEqual([]);
  });
});
