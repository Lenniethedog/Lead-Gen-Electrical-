import type { Logger } from "pino";
import { DELIVERY_POLICY } from "@/config/delivery";
import { verifyTwilioSignature } from "@/integrations/delivery";
import type { DeliveryService } from "@/modules/delivery";

export interface TwilioCallbackDeps {
  delivery: Pick<DeliveryService, "applyProviderEvent">;
  logger: Logger;
  /** TWILIO_AUTH_TOKEN. Without it the endpoint refuses everything (503): an unverifiable callback must never be believed. */
  authToken: string | undefined;
  /** The exact URL Twilio was told to call (it signs it). */
  callbackUrl: string;
}

const KNOWN_STATUSES = new Set(["accepted", "scheduled", "queued", "sending", "sent", "delivered", "undelivered", "failed", "read", "receiving", "received", "canceled"]);
const SID = /^(SM|MM)[0-9a-f]{32}$/i;
const empty = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });

/**
 * POST /api/webhooks/twilio: Twilio's delivery reports for our text messages. PUBLIC (Twilio is not behind Cloudflare Access), so it trusts
 * nothing until the request signature checks out; the order is: method, token configured, body size, signature, shape, apply.
 *   200  applied, ignored, a repeat, or not (yet) ours: Twilio must not retry any of these
 *   400  signed but malformed    403 bad or missing signature    405 not POST    413 too large    503 not configured    500 our fault (Twilio retries)
 */
export function createTwilioCallbackHandler(deps: TwilioCallbackDeps): (request: Request) => Promise<Response> {
  return async function handleTwilioCallback(request: Request): Promise<Response> {
    if (request.method !== "POST") return empty(405);
    if (!deps.authToken) {
      deps.logger.error({ check: "twilio-callback" }, "a Twilio callback arrived but TWILIO_AUTH_TOKEN is not set: it cannot be verified");
      return empty(503);
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > DELIVERY_POLICY.callbackMaxBytes) return empty(413);
    if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded")) return empty(400);

    let text: string;
    try {
      text = await request.text();
    } catch {
      return empty(400);
    }
    if (text.length > DELIVERY_POLICY.callbackMaxBytes) return empty(413);

    const params: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(text)) params[key] = value;
    if (!verifyTwilioSignature(deps.authToken, deps.callbackUrl, params, request.headers.get("x-twilio-signature"))) {
      deps.logger.warn({ check: "twilio-callback" }, "a Twilio callback failed signature verification");
      return empty(403);
    }

    const sid = params.MessageSid ?? "";
    const status = (params.MessageStatus ?? params.SmsStatus ?? "").toLowerCase();
    if (!SID.test(sid) || !KNOWN_STATUSES.has(status)) return empty(400);
    const errorCode = /^\d{1,6}$/.test(params.ErrorCode ?? "") ? params.ErrorCode! : null;

    try {
      const result = await deps.delivery.applyProviderEvent({ provider: "twilio", eventId: `${sid}:${status}`, sid, status, errorCode });
      deps.logger.info({ check: "twilio-callback", status, result }, "twilio delivery report");
      return empty(200);
    } catch (error) {
      deps.logger.error({ err: error, check: "twilio-callback" }, "could not apply a Twilio delivery report; Twilio will retry");
      return empty(500);
    }
  };
}
