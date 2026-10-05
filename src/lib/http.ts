import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  AppError,
  BadRequestError,
  ForbiddenOriginError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
} from "./errors";
import { resolveClientIp, resolveCountry, type ClientIpConfig } from "./ip";

export interface RequestContext {
  /** Correlates logs, lead events and error responses for one request. */
  requestId: string;
  ip: string | null;
  /** Two-letter country from Cloudflare when trusted (XX = unknown, T1 = Tor), else null. */
  country: string | null;
  userAgent: string | null;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,100}$/;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export function buildRequestContext(request: Request, ipConfig: ClientIpConfig): RequestContext {
  const incomingId = request.headers.get("x-request-id");
  const userAgent = request.headers.get("user-agent")?.replace(CONTROL_CHARACTERS, "").trim().slice(0, 512);
  return {
    // An incoming id is accepted only if it is boring: it ends up in logs, so no free-form text.
    requestId: incomingId && REQUEST_ID_PATTERN.test(incomingId) ? incomingId : randomUUID(),
    ip: resolveClientIp(request.headers, ipConfig),
    country: resolveCountry(request.headers, ipConfig),
    userAgent: userAgent ? userAgent : null,
  };
}

/**
 * Browsers always send Origin on cross-origin POSTs. Rejecting unknown origins stops other sites
 * from driving our form endpoint from their visitors' browsers. It is NOT an authentication
 * mechanism (non-browser clients can send any Origin) - Turnstile, rate limits and fraud scoring
 * handle those.
 */
export function assertAllowedOrigin(request: Request, allowedOrigins: readonly string[]): void {
  const origin = request.headers.get("origin");
  if (origin === null) return;
  if (!allowedOrigins.some((allowed) => originMatches(origin, allowed))) throw new ForbiddenOriginError();
}

/** Exact match, except the two development entries `http://localhost:*` and `http://127.0.0.1:*`, which match any port on that host. */
const ANY_PORT_ENTRY = /^http:\/\/(localhost|127\.0\.0\.1):\*$/;
function originMatches(origin: string, allowed: string): boolean {
  if (origin === allowed) return true;
  const entry = ANY_PORT_ENTRY.exec(allowed);
  return entry !== null && new RegExp(`^http://${entry[1]!.replaceAll(".", "\\.")}:\\d{1,5}$`).test(origin);
}

/** Reads and parses a JSON body, enforcing a hard size cap while streaming (not after buffering). */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(contentType)) throw new UnsupportedMediaTypeError();

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();

  const reader = request.body?.getReader();
  if (!reader) throw new BadRequestError("empty_body", "The request body is empty.");

  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BadRequestError("invalid_encoding", "The request body must be UTF-8 text.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequestError("invalid_json", "The request body is not valid JSON.");
  }
}

interface JsonResponseOptions {
  status?: number;
  headers?: Record<string, string>;
  requestId?: string;
}

export function jsonResponse(body: unknown, options: JsonResponseOptions = {}): Response {
  const headers = new Headers(options.headers);
  headers.set("cache-control", "no-store");
  if (options.requestId) headers.set("x-request-id", options.requestId);
  return Response.json(body, { status: options.status ?? 200, headers });
}

/**
 * Maps any thrown value to a response. AppErrors carry a deliberate public code/message; anything
 * else is a bug and is reported generically (details go to the log, never to the client).
 */
export function errorResponse(error: unknown, context: { requestId: string; logger: Logger }): Response {
  if (error instanceof AppError) {
    context.logger.info({ code: error.code, status: error.status }, "request rejected");
    return jsonResponse(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields && { fields: error.fields }),
          requestId: context.requestId,
        },
      },
      { status: error.status, ...(error.headers && { headers: error.headers }), requestId: context.requestId },
    );
  }

  context.logger.error({ err: error }, "unhandled error while handling request");
  return jsonResponse(
    {
      error: {
        code: "internal_error",
        message: "Something went wrong on our side. Please try again.",
        requestId: context.requestId,
      },
    },
    { status: 500, requestId: context.requestId },
  );
}
