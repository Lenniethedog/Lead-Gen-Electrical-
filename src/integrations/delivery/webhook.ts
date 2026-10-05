import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { DELIVERY_POLICY } from "@/config/delivery";
import { signWebhook } from "@/lib/secrets";
import type { SendResult, WebhookMessage, WebhookSender } from "@/modules/delivery";
import { isPublicAddress } from "./ssrf";

export interface WebhookSenderOptions {
  /** Injectable for tests: resolves a hostname to addresses. Default: the system resolver, ALL addresses. */
  resolve?: (hostname: string) => Promise<string[]>;
  /**
   * TESTS ONLY (the environment schema refuses the setting that turns this on in staging/production): allow plain http and
   * loopback/private destinations, so a local receiver can be used. Everything else (no redirects, size cap, timeout, signing) still applies.
   */
  allowLoopbackForTests?: boolean;
  userAgent?: string;
}

const defaultResolve = async (hostname: string): Promise<string[]> => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Signed webhook delivery to a business's own system (docs/03). Defences, in order:
 *   1. https only, no credentials in the URL;
 *   2. resolve the name and REFUSE if any address is not public (the destination could be our own network);
 *   3. connect to the address we validated (no second DNS lookup an attacker could answer differently: DNS rebinding), with the original
 *      host name for TLS verification and the Host header;
 *   4. never follow a redirect (a 3xx to an internal address would defeat step 2);
 *   5. read at most a capped amount of the response and keep only the status code;
 *   6. a hard timeout.
 * 2xx = accepted. 408, 429 and 5xx are retried; other 4xx are permanent (the business's system rejected it), as are 3xx.
 */
export function createWebhookSender(options: WebhookSenderOptions = {}): WebhookSender {
  const resolve = options.resolve ?? defaultResolve;
  const loose = options.allowLoopbackForTests === true;

  return {
    async send(message: WebhookMessage, { signal }): Promise<SendResult> {
      let url: URL;
      try {
        url = new URL(message.url);
      } catch {
        return { outcome: "permanent_failure", errorCode: "invalid_url" };
      }
      if (url.protocol !== "https:" && !(loose && url.protocol === "http:")) return { outcome: "permanent_failure", errorCode: "https_required" };
      if (url.username || url.password) return { outcome: "permanent_failure", errorCode: "credentials_in_url" };

      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      let addresses: string[];
      try {
        addresses = /^[0-9.]+$/.test(hostname) || hostname.includes(":") ? [hostname] : await resolve(hostname);
      } catch {
        return { outcome: "retryable_failure", errorCode: "dns_error" };
      }
      if (addresses.length === 0) return { outcome: "retryable_failure", errorCode: "dns_error" };
      if (!loose && !addresses.every(isPublicAddress)) return { outcome: "permanent_failure", errorCode: "destination_not_public" };
      const address = addresses[0]!;

      const timestamp = Math.floor(Date.now() / 1000);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(message.body)),
        host: url.host,
        "user-agent": options.userAgent ?? "leadgen-webhook/1",
        "x-leadgen-event": message.event,
        "x-leadgen-delivery": message.deliveryId,
        "x-leadgen-timestamp": String(timestamp),
        "x-leadgen-signature": signWebhook(message.secret, timestamp, message.body),
      };

      return new Promise<SendResult>((resolvePromise) => {
        let settled = false;
        const finish = (result: SendResult) => {
          if (settled) return;
          settled = true;
          resolvePromise(result);
        };
        const transport = url.protocol === "https:" ? https : http;
        const request = transport.request(
          {
            host: address,
            port: url.port || (url.protocol === "https:" ? 443 : 80),
            path: `${url.pathname}${url.search}`,
            method: "POST",
            headers,
            servername: url.protocol === "https:" && !/^[0-9.]+$/.test(hostname) && !hostname.includes(":") ? hostname : undefined,
            signal,
            timeout: DELIVERY_POLICY.webhookTimeoutMs,
          } as https.RequestOptions,
          (response) => {
            let received = 0;
            response.on("data", (chunk: Buffer) => {
              received += chunk.length;
              if (received > DELIVERY_POLICY.webhookMaxResponseBytes) response.destroy(); // enough: only the status matters
            });
            const status = response.statusCode ?? 0;
            const done = () => {
              if (status >= 200 && status < 300) finish({ outcome: "accepted" });
              else if (status === 408 || status === 429 || status >= 500) finish({ outcome: "retryable_failure", errorCode: `http_${status}`, httpStatus: status });
              else if (status >= 300 && status < 400) finish({ outcome: "permanent_failure", errorCode: "redirect_not_followed", httpStatus: status });
              else finish({ outcome: "permanent_failure", errorCode: `http_${status}`, httpStatus: status });
            };
            response.on("end", done);
            response.on("close", done); // destroyed because it was too large: the status is still what counts
            response.on("error", done);
          },
        );
        request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
        request.on("error", (error: Error & { code?: string }) => {
          const timedOut = error.name === "TimeoutError" || error.name === "AbortError" || error.code === "ABORT_ERR";
          finish({ outcome: "retryable_failure", errorCode: timedOut ? "timeout" : "network_error" });
        });
        request.end(message.body);
      });
    },
  };
}
