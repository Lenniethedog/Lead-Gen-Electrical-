import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { computeTwilioSignature } from "../../src/integrations/delivery";
import { createTwilioCallbackHandler } from "../../src/server/handlers/twilio-callback";
import { buildDelivery, type DeliveryEnv } from "../helpers/delivery";

/** The public endpoint for Twilio's delivery reports: nothing is believed until the signature checks out. */
let env: DeliveryEnv;
afterEach(async () => {
  await env?.destroy();
});

const TOKEN = "twilio-auth-token-for-tests-0123";
const URL_ = "https://www.example.com/api/webhooks/twilio";
const SID = "SM22222222222222222222222222222222";

async function setup() {
  env = await buildDelivery();
  const client = await env.automaticClient(env.owner, { email: false, sms: true });
  const { assignmentId } = await env.assign(client);
  env.sms.queue({ outcome: "accepted", providerMessageId: SID });
  await env.drain();
  const handler = createTwilioCallbackHandler({ delivery: env.delivery, logger: pino({ level: "silent" }), authToken: TOKEN, callbackUrl: URL_ });
  const [sms] = await env.notifications(assignmentId);
  return { handler, sms: sms!, assignmentId };
}

function post(params: Record<string, string>, options: { token?: string; signature?: string | null; contentType?: string; method?: string; url?: string } = {}) {
  const body = new URLSearchParams(params).toString();
  const signature = options.signature === undefined ? computeTwilioSignature(options.token ?? TOKEN, options.url ?? URL_, params) : options.signature;
  return new Request(URL_, {
    method: options.method ?? "POST",
    headers: { "content-type": options.contentType ?? "application/x-www-form-urlencoded", ...(signature !== null && { "x-twilio-signature": signature }) },
    ...((options.method ?? "POST") === "POST" && { body }),
  });
}
const report = (status: string, extra: Record<string, string> = {}) => ({ MessageSid: SID, MessageStatus: status, To: "+447911123456", From: "MG1", AccountSid: "AC1", ...extra });
const status = async (id: string) => (await env.t.admin.selectFrom("notifications").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;

describe("a genuine report", () => {
  it("is applied: the text becomes delivered, and a repeat is answered 200 and changes nothing", async () => {
    const { handler, sms } = await setup();
    expect((await handler(post(report("delivered")))).status).toBe(200);
    expect(await status(sms.id)).toBe("delivered");
    expect((await handler(post(report("delivered")))).status).toBe(200);
    expect(await env.t.admin.selectFrom("provider_events").select("id").execute()).toHaveLength(1);
  });
  it("an undelivered report carries the error code onto the notification", async () => {
    const { handler, sms } = await setup();
    expect((await handler(post(report("undelivered", { ErrorCode: "30003" })))).status).toBe(200);
    expect(await env.t.admin.selectFrom("notifications").select(["status", "last_error_code"]).where("id", "=", sms.id).executeTakeFirstOrThrow()).toEqual({ status: "failed", last_error_code: "twilio_30003" });
  });
  it("a report for a message that is not ours is acknowledged (so Twilio stops) and kept unprocessed", async () => {
    const { handler } = await setup();
    expect((await handler(post({ ...report("delivered"), MessageSid: "SM" + "9".repeat(32) }))).status).toBe(200);
    expect((await env.t.admin.selectFrom("provider_events").select("processed_at").executeTakeFirstOrThrow()).processed_at).toBeNull();
  });
  it("the stored event holds no phone number from the report", async () => {
    const { handler } = await setup();
    await handler(post(report("delivered", { To: "+447999888777" })));
    expect(JSON.stringify(await env.t.admin.selectFrom("provider_events").selectAll().execute())).not.toContain("447999888777");
  });
});

describe("anything that is not a verified report is refused, and changes nothing", () => {
  it("missing, wrong, truncated and other-token signatures: 403", async () => {
    const { handler, sms } = await setup();
    const good = computeTwilioSignature(TOKEN, URL_, report("delivered"));
    for (const signature of [null, "", "AAAA", good.slice(0, -2), good.replace(/.$/, good.endsWith("A") ? "B" : "A"), computeTwilioSignature("another-token-another-token", URL_, report("delivered"))]) {
      expect((await handler(post(report("delivered"), { signature }))).status, String(signature)).toBe(403);
    }
    expect(await status(sms.id)).toBe("sent");
    expect(await env.t.admin.selectFrom("provider_events").select("id").execute()).toHaveLength(0);
  });
  it("a valid signature for a DIFFERENT url, or over altered parameters, is refused", async () => {
    const { handler, sms } = await setup();
    expect((await handler(post(report("delivered"), { url: "https://evil.example.com/api/webhooks/twilio" }))).status).toBe(403);
    const signature = computeTwilioSignature(TOKEN, URL_, report("undelivered"));
    expect((await handler(post(report("delivered"), { signature }))).status).toBe(403);
    expect(await status(sms.id)).toBe("sent");
  });
  it("without an auth token configured the endpoint answers 503 to everything, even a perfectly signed request", async () => {
    const { sms } = await setup();
    const handler = createTwilioCallbackHandler({ delivery: env.delivery, logger: pino({ level: "silent" }), authToken: undefined, callbackUrl: URL_ });
    expect((await handler(post(report("delivered")))).status).toBe(503);
    expect(await status(sms.id)).toBe("sent");
  });
  it("only POST; only form bodies; not too large", async () => {
    const { handler } = await setup();
    expect((await handler(post(report("delivered"), { method: "GET" }))).status).toBe(405);
    expect((await handler(post(report("delivered"), { contentType: "application/json" }))).status).toBe(400);
    const big = { ...report("delivered"), Padding: "x".repeat(20_000) };
    expect((await handler(post(big))).status).toBe(413);
  });
  it("a correctly signed but malformed report is 400 and stores nothing", async () => {
    const { handler } = await setup();
    const malformed: Array<Record<string, string>> = [{ ...report("delivered"), MessageSid: "not-a-sid" }, { ...report("teleported") }, { MessageStatus: "delivered" }, { MessageSid: SID }];
    for (const params of malformed) {
      expect((await handler(post(params))).status, JSON.stringify(params)).toBe(400);
    }
    expect(await env.t.admin.selectFrom("provider_events").select("id").execute()).toHaveLength(0);
  });
});
