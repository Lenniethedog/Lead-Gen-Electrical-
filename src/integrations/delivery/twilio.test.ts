import { describe, expect, it } from "vitest";
import { computeTwilioSignature, createTwilioSender, verifyTwilioSignature } from "./twilio";

describe("Twilio request signatures", () => {
  // The worked example from Twilio's own documentation (Security > Validating requests).
  const token = "12345";
  const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
  const params = { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" };
  const expected = "0/KCTR6DLpKmkAf8muzZqo1nDgQ=";

  it("reproduces Twilio's published example, so the algorithm is the one Twilio uses", () => {
    expect(computeTwilioSignature(token, url, params)).toBe(expected);
  });
  it("verifies that, and refuses a changed parameter, URL, token, an empty signature and a wrong one", () => {
    expect(verifyTwilioSignature(token, url, params, expected)).toBe(true);
    expect(verifyTwilioSignature(token, url, { ...params, Digits: "9999" }, expected)).toBe(false);
    expect(verifyTwilioSignature(token, url + "x", params, expected)).toBe(false);
    expect(verifyTwilioSignature("other", url, params, expected)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, null)).toBe(false);
    expect(verifyTwilioSignature(token, url, params, "")).toBe(false);
    expect(verifyTwilioSignature(token, url, params, expected.slice(0, -2))).toBe(false);
  });
  it("does not depend on the order the parameters arrive in", () => {
    const shuffled = Object.fromEntries(Object.entries(params).reverse());
    expect(computeTwilioSignature(token, url, shuffled)).toBe(expected);
  });
});

describe("the Twilio sender", () => {
  const build = (respond: (init: RequestInit) => Response | Promise<Response>) => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const sender = createTwilioSender({
      accountSid: "AC123", apiKeySid: "SK1", apiKeySecret: "secret", messagingServiceSid: "MG1", statusCallbackUrl: "https://app.example/api/webhooks/twilio",
      fetchImpl: async (url, init) => { calls.push({ url: String(url), init: init! }); return respond(init!); },
    });
    return { sender, calls };
  };
  const message = { to: "+447123456789", body: "hello", notificationId: "n1" };
  const ctx = { signal: new AbortController().signal };

  it("posts the documented request: Basic auth with the API key, the messaging service, the callback, and no redirects", async () => {
    const { sender, calls } = build(() => Response.json({ sid: "SM123" }, { status: 201 }));
    expect(await sender.send(message, ctx)).toEqual({ outcome: "accepted", providerMessageId: "SM123" });
    const call = calls[0]!;
    expect(call.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("SK1:secret").toString("base64")}`);
    const form = new URLSearchParams(String(call.init.body));
    expect(Object.fromEntries(form)).toEqual({ To: "+447123456789", MessagingServiceSid: "MG1", Body: "hello", StatusCallback: "https://app.example/api/webhooks/twilio" });
    expect(call.init.redirect).toBe("error");
  });
  it("retries rate limits, server errors, timeouts and credential problems; gives up on a number that cannot receive", async () => {
    for (const [status, code, outcome] of [[429, 20429, "retryable_failure"], [500, 20500, "retryable_failure"], [503, 0, "retryable_failure"], [401, 20003, "retryable_failure"], [400, 21211, "permanent_failure"], [400, 21610, "permanent_failure"], [404, 20404, "permanent_failure"]] as const) {
      const { sender } = build(() => Response.json({ code }, { status }));
      expect(await sender.send(message, ctx), `${status}/${code}`).toMatchObject({ outcome, httpStatus: status });
    }
    const { sender: dead } = build(() => { throw Object.assign(new Error("x"), { name: "TimeoutError" }); });
    expect(await dead.send(message, ctx)).toEqual({ outcome: "retryable_failure", errorCode: "timeout" });
    const { sender: broken } = build(() => { throw new Error("ECONNRESET"); });
    expect(await broken.send(message, ctx)).toEqual({ outcome: "retryable_failure", errorCode: "network_error" });
  });
  it("never reports success without a message id, and copes with a body that is not JSON", async () => {
    const { sender } = build(() => new Response("<html>", { status: 201 }));
    expect(await sender.send(message, ctx)).toMatchObject({ outcome: "permanent_failure" });
  });
  it("puts the provider's error code in the result, and none of the message in it", async () => {
    const { sender } = build(() => Response.json({ code: 21211, message: "The 'To' number +447123456789 is not valid" }, { status: 400 }));
    const result = await sender.send(message, ctx);
    expect(JSON.stringify(result)).not.toContain("447123456789");
    expect(result).toMatchObject({ errorCode: "twilio_21211" });
  });
});
