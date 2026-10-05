import type { Logger } from "pino";
import * as z from "zod";
import { BadRequestError, RateLimitedError } from "@/lib/errors";
import { assertAllowedOrigin, buildRequestContext, errorResponse, jsonResponse, readJsonBody } from "@/lib/http";
import type { ClientIpConfig } from "@/lib/ip";
import type { SlidingWindowRateLimiter } from "@/lib/rate-limit";
import type { PostcodeService } from "@/modules/postcodes";
import type { ReferenceDataProvider } from "@/modules/reference";

export interface CheckPostcodeDeps {
  postcodes: PostcodeService;
  reference: ReferenceDataProvider;
  verticalSlug: string;
  logger: Logger;
  ipConfig: ClientIpConfig;
  allowedOrigins: readonly string[];
  rateLimiter: SlidingWindowRateLimiter;
}

const bodySchema = z.object({ postcode: z.string().max(20) });

/**
 * POST /api/v1/postcodes/check - "do we cover this postcode?" for step 2 of the form.
 * POST (not GET) so the postcode never lands in URLs, proxy logs or browser history.
 * Always answers 200 with a status: "not covered" is a normal outcome, not an error.
 */
export async function handleCheckPostcode(request: Request, deps: CheckPostcodeDeps): Promise<Response> {
  const context = buildRequestContext(request, deps.ipConfig);
  const logger = deps.logger.child({ requestId: context.requestId, route: "POST /api/v1/postcodes/check" });

  try {
    assertAllowedOrigin(request, deps.allowedOrigins);
    if (context.ip !== null) {
      const limit = deps.rateLimiter.check(context.ip);
      if (!limit.allowed) throw new RateLimitedError(limit.retryAfterSeconds);
    }

    const parsed = bodySchema.safeParse(await readJsonBody(request, 1024));
    if (!parsed.success) throw new BadRequestError("invalid_request", "Send a JSON body like {\"postcode\":\"BR6 0AA\"}.");

    const reference = await deps.reference.get(deps.verticalSlug);
    const result = await deps.postcodes.check(parsed.data.postcode, reference.verticalId);

    // Coordinates are internal (routing); the browser only needs the verdict and a friendly area name.
    const data =
      result.status === "covered"
        ? { status: result.status, postcode: result.postcode, areaName: result.areaName }
        : { status: result.status };
    return jsonResponse({ data }, { requestId: context.requestId });
  } catch (error) {
    return errorResponse(error, { requestId: context.requestId, logger });
  }
}
