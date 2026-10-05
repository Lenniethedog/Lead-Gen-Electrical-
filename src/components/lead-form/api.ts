import type { WireAttribution } from "./attribution";

export interface SubmitPayload {
  service: string;
  postcode: string;
  propertyType: string;
  ownership: string;
  scope: string;
  urgency: string;
  contact: { name: string; phone: string; email: string; notes: string };
  consent: { accepted: true; textVersion: string };
  context: {
    elapsedMs: number;
    turnstileToken?: string;
    honeypot: string;
    pagePath: string;
    attribution: WireAttribution;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
    readonly retryAfterSeconds?: number,
    /** Quote this to support: it ties the failure to the server's logs. */
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RetryOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  timeoutMs?: number;
  random?: () => number;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function parseError(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get("retry-after"));
  try {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; fields?: Record<string, string>; requestId?: string };
    };
    return new ApiError(
      response.status,
      body.error?.code ?? "unknown_error",
      body.error?.message ?? "Something went wrong.",
      body.error?.fields,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      body.error?.requestId,
    );
  } catch {
    return new ApiError(response.status, "unknown_error", "Something went wrong.");
  }
}

type Attempt =
  | { kind: "success"; reference: string }
  | { kind: "retryable"; error: ApiError }
  | { kind: "fatal"; error: ApiError };

/** 5xx, request timeout and rate limiting say nothing about the content, so they are worth retrying. */
function isRetryable(error: ApiError): boolean {
  if (error.status >= 500 || error.status === 408) return true;
  return error.status === 429 && (error.retryAfterSeconds ?? 1) <= 8;
}

const networkError = () => new ApiError(0, "network_error", "We couldn't reach our servers.");

async function attemptOnce(
  payload: SubmitPayload,
  idempotencyKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl("/api/v1/leads", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify(payload),
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });

    if (response.ok) {
      const body = (await response.json()) as { data?: { reference?: unknown } };
      return typeof body.data?.reference === "string"
        ? { kind: "success", reference: body.data.reference }
        : { kind: "fatal", error: new ApiError(502, "invalid_response", "Unexpected response.") };
    }

    const error = await parseError(response);
    return isRetryable(error) ? { kind: "retryable", error } : { kind: "fatal", error };
  } catch {
    // fetch rejected (offline, DNS, connection reset) or our own timeout aborted the request.
    return { kind: "retryable", error: networkError() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends the enquiry. Safe to retry because the server is idempotent on `idempotencyKey`: a request
 * that reached the server but whose response was lost returns the SAME lead on the retry instead
 * of creating a second one. Only failures that say nothing about the content are retried (see
 * isRetryable); any other 4xx is a decision and is surfaced to the user straight away.
 */
export async function submitLead(
  payload: SubmitPayload,
  idempotencyKey: string,
  options: RetryOptions = {},
): Promise<{ reference: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? wait;
  const maxAttempts = options.maxAttempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const random = options.random ?? Math.random;
  let lastError = networkError();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await attemptOnce(payload, idempotencyKey, fetchImpl, timeoutMs);
    if (result.kind === "success") return { reference: result.reference };
    if (result.kind === "fatal") throw result.error;
    lastError = result.error;
    if (attempt < maxAttempts) {
      await sleep(Math.max(backoffMs(attempt, random), (lastError.retryAfterSeconds ?? 0) * 1000));
    }
  }
  throw lastError;
}

function backoffMs(attempt: number, random: () => number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(random() * 250);
}

export type CoverageResponse =
  | { status: "covered"; postcode: string; areaName: string }
  | { status: "out_of_area" | "not_found" | "invalid_format" };

export async function checkPostcode(postcode: string, signal?: AbortSignal): Promise<CoverageResponse> {
  const response = await fetch("/api/v1/postcodes/check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ postcode }),
    ...(signal && { signal }),
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw await parseError(response);
  const body = (await response.json()) as { data?: CoverageResponse };
  if (!body.data) throw new ApiError(502, "invalid_response", "Unexpected response.");
  return body.data;
}
