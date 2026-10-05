import type { EmailMessage, EmailSender, SendResult } from "@/modules/alerts/ports";

/**
 * Resend adapter (https://resend.com/docs/api-reference/emails/send-email), over plain fetch:
 * one endpoint, so an SDK would add a dependency and nothing else.
 *
 * Reliability contract with the alert service:
 *   - the Idempotency-Key header is the alert's stable key, so a retry after "the worker died after
 *     the provider accepted it" is answered with the original result instead of a second email;
 *   - every failure is classified as retryable or permanent and returned, never thrown;
 *   - the response body is never logged or stored (it can echo recipient addresses); only the
 *     provider's short error `name` is kept, and only after sanitising.
 *
 * NOT verified against the live service (no account was available): the request shape follows the
 * published API reference, and the behaviour is tested against a local fake. Send one real alert
 * from staging before relying on it (docs/runbook.md).
 */
export interface ResendSenderOptions {
  apiKey: string;
  /** "Display Name <address@verified-domain>" */
  from: string;
  baseUrl?: string | undefined;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.resend.com";

/** HTTP statuses where trying again later can succeed: rate limit, request timeout, in-flight duplicate, server errors. */
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);
/** Bad or unauthorised credentials are a configuration problem that may be fixed within the retry window. */
const CONFIGURATION_STATUSES = new Set([401, 403]);

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function cleanCode(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 60);
  return cleaned || fallback;
}

export function createResendSender(options: ResendSenderOptions): EmailSender {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async send(message: EmailMessage, { signal }): Promise<SendResult> {
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/emails`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": message.idempotencyKey,
            "user-agent": "leadgen-worker",
          },
          body: JSON.stringify({ from: options.from, to: [...message.to], subject: message.subject, text: message.text }),
          redirect: "manual",
          signal,
        });
      } catch (error) {
        return { outcome: "retryable_failure", errorCode: isAbortError(error) ? "timeout" : "network_error" };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      const field = (name: string) => (body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined);

      if (response.status >= 200 && response.status < 300) {
        const id = field("id");
        return { outcome: "accepted", ...(typeof id === "string" && { providerMessageId: id.slice(0, 200) }) };
      }

      const httpStatus = response.status;
      const errorCode = cleanCode(field("name"), `http_${httpStatus}`);
      if (httpStatus >= 500 || RETRYABLE_STATUSES.has(httpStatus) || CONFIGURATION_STATUSES.has(httpStatus)) {
        return { outcome: "retryable_failure", errorCode, httpStatus };
      }
      return { outcome: "permanent_failure", errorCode, httpStatus };
    },
  };
}
