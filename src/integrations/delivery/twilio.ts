import { createHmac, timingSafeEqual } from "node:crypto";
import type { SendResult, SmsMessage, SmsSender } from "@/modules/delivery";

export interface TwilioSenderOptions {
  accountSid: string;
  /** An API key (not the account auth token) scoped to this app. */
  apiKeySid: string;
  apiKeySecret: string;
  /** A Messaging Service with a registered UK sender: it chooses the sender and handles opt-outs. */
  messagingServiceSid: string;
  /** Where Twilio reports delivery (https://<host>/api/webhooks/twilio). */
  statusCallbackUrl: string;
  /** Tests only: point the adapter at a local fake. Refused in staging/production by the environment schema. */
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Twilio Programmable Messaging adapter (https://www.twilio.com/docs/messaging/api/message-resource). Twilio has no idempotency key, so an
 * attempt that timed out after Twilio accepted it can send twice: the text carries the lead reference so a duplicate is recognisable.
 * Invalid numbers (21211, 21614) and opted-out recipients (21610) are permanent; rate limits (429) and server errors are retried.
 */
export function createTwilioSender(options: TwilioSenderOptions): SmsSender {
  const base = (options.baseUrl ?? "https://api.twilio.com").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const authorization = `Basic ${Buffer.from(`${options.apiKeySid}:${options.apiKeySecret}`).toString("base64")}`;

  return {
    async send(message: SmsMessage, { signal }): Promise<SendResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${base}/2010-04-01/Accounts/${options.accountSid}/Messages.json`, {
          method: "POST",
          headers: { authorization, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ To: message.to, MessagingServiceSid: options.messagingServiceSid, Body: message.body, StatusCallback: options.statusCallbackUrl }),
          signal,
          redirect: "error",
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { outcome: "retryable_failure", errorCode: timedOut ? "timeout" : "network_error" };
      }
      let body: { sid?: string; code?: number } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        /* a non-JSON body is handled by the status below */
      }
      if (response.status === 201 && body.sid) return { outcome: "accepted", providerMessageId: body.sid };
      const errorCode = `twilio_${body.code ?? response.status}`;
      if (response.status === 429 || response.status >= 500 || response.status === 408) return { outcome: "retryable_failure", errorCode, httpStatus: response.status };
      // 401/403 are credentials a person can fix: retry rather than bury the lead's text.
      if (response.status === 401 || response.status === 403) return { outcome: "retryable_failure", errorCode, httpStatus: response.status };
      return { outcome: "permanent_failure", errorCode, httpStatus: response.status };
    },
  };
}

/**
 * Twilio's documented request signature (https://www.twilio.com/docs/usage/security#validating-requests): base64 HMAC-SHA1, keyed with the
 * account auth token, over the full URL followed by every POST parameter as name+value, sorted by name. Hand-written instead of pulling in
 * the 16 MB official SDK for one function; proven against Twilio's published example in the tests.
 */
export function computeTwilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params).sort().reduce((text, key) => text + key + params[key], url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string | null): boolean {
  if (!signature) return false;
  const expected = Buffer.from(computeTwilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
