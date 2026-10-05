import type { Logger } from "pino";
import { BadRequestError, RateLimitedError } from "@/lib/errors";
import { assertAllowedOrigin, buildRequestContext, errorResponse, jsonResponse, readJsonBody } from "@/lib/http";
import type { ClientIpConfig } from "@/lib/ip";
import type { SlidingWindowRateLimiter } from "@/lib/rate-limit";
import { parseLeadSubmission, type LeadService } from "@/modules/leads";

export interface SubmitLeadDeps {
  leadService: LeadService;
  logger: Logger;
  ipConfig: ClientIpConfig;
  allowedOrigins: readonly string[];
  rateLimiter: SlidingWindowRateLimiter;
}

/** 16 KiB is ~10x a maximal legitimate submission; anything bigger is abuse. */
export const MAX_BODY_BYTES = 16 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseIdempotencyKey(value: string | null): string {
  if (value === null || value.trim() === "") {
    throw new BadRequestError("idempotency_key_required", "Send an Idempotency-Key header containing a UUID.");
  }
  if (!UUID.test(value.trim())) {
    throw new BadRequestError("idempotency_key_invalid", "The Idempotency-Key header must be a UUID.");
  }
  return value.trim().toLowerCase();
}

/**
 * POST /api/v1/leads - the controller. It translates HTTP into a service call and back; every
 * decision about leads lives in the service. Order matters: cheap rejections first, so abusive
 * traffic never reaches the database.
 */
export async function handleSubmitLead(request: Request, deps: SubmitLeadDeps): Promise<Response> {
  const context = buildRequestContext(request, deps.ipConfig);
  const logger = deps.logger.child({ requestId: context.requestId, route: "POST /api/v1/leads" });

  try {
    assertAllowedOrigin(request, deps.allowedOrigins);

    // Per-IP burst control. Skipped when the address is unknown: sharing one bucket between all
    // unidentifiable clients would let one abuser lock everyone out.
    if (context.ip !== null) {
      const limit = deps.rateLimiter.check(context.ip);
      if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);
    }

    const idempotencyKey = parseIdempotencyKey(request.headers.get("idempotency-key"));
    const body = await readJsonBody(request, MAX_BODY_BYTES);
    const submission = parseLeadSubmission(body);

    const result = await deps.leadService.submit({
      idempotencyKey,
      submission,
      request: { requestId: context.requestId, ip: context.ip, country: context.country, userAgent: context.userAgent },
    });

    // The response is identical for every internal outcome (accepted, held for review, duplicate,
    // rejected as spam): it must not teach a bot or a prober how we screen.
    const replayed = result.outcome === "replayed";
    return jsonResponse(
      { data: { reference: result.reference } },
      {
        status: replayed ? 200 : 201,
        requestId: context.requestId,
        ...(replayed && { headers: { "Idempotent-Replayed": "true" } }),
      },
    );
  } catch (error) {
    return errorResponse(error, { requestId: context.requestId, logger });
  }
}
