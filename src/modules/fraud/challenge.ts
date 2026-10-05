/**
 * Bot challenge verification (Cloudflare Turnstile).
 *
 * Outcomes are deliberately four-valued, because each demands different handling:
 *   passed       - proceed
 *   failed       - the token is invalid/expired/already used: reject with a retryable 403
 *   missing      - the client sent no token (blocker, script failed to load, or a bot): do NOT
 *                  reject (that would lose real leads from privacy-extension users); the
 *                  fraud score pushes it into manual review instead
 *   unavailable  - OUR side is broken (Cloudflare down, bad secret): fail open with a penalty,
 *                  because a verification outage must never cost us leads
 */
export type ChallengeResult =
  | { status: "passed" }
  | { status: "failed"; codes: string[] }
  | { status: "missing" }
  | { status: "unavailable"; reason: string };

export interface ChallengeVerifier {
  verify(input: { token: string | undefined; ip: string | null; idempotencyKey: string }): Promise<ChallengeResult>;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Error codes that mean the TOKEN is bad (client may retry with a fresh one). */
const TOKEN_ERRORS = new Set(["invalid-input-response", "timeout-or-duplicate", "missing-input-response"]);

interface TurnstileOptions {
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createTurnstileVerifier(options: TurnstileOptions): ChallengeVerifier {
  const timeoutMs = options.timeoutMs ?? 3_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async verify({ token, ip, idempotencyKey }) {
      if (token === undefined || token.trim() === "") return { status: "missing" };

      const body = new URLSearchParams({ secret: options.secret, response: token, idempotency_key: idempotencyKey });
      if (ip) body.set("remoteip", ip);

      let response: Response;
      try {
        response = await fetchImpl(SITEVERIFY_URL, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return { status: "unavailable", reason: error instanceof Error ? error.name : "network_error" };
      }
      if (!response.ok) return { status: "unavailable", reason: `http_${response.status}` };

      let payload: { success?: boolean; "error-codes"?: string[] };
      try {
        payload = (await response.json()) as typeof payload;
      } catch {
        return { status: "unavailable", reason: "invalid_response" };
      }

      if (payload.success === true) return { status: "passed" };

      const codes = payload["error-codes"] ?? [];
      // Anything that is not clearly "this token is bad" is our configuration or their outage.
      if (codes.length === 0 || !codes.every((code) => TOKEN_ERRORS.has(code))) {
        return { status: "unavailable", reason: codes.join(",") || "unknown_error" };
      }
      return { status: "failed", codes };
    },
  };
}
