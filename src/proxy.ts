import { NextResponse, type NextRequest } from "next/server";
import { getLogger } from "@/lib/logger";
import { getAdminAuthorizer } from "@/server/admin/authorizer";

/**
 * First gate for the operator inbox: nothing under /admin runs (no page, no server action) unless
 * the request carries a valid Cloudflare Access token for an allowlisted operator.
 *
 * This is deliberately NOT the only check. Next's own guidance is that a proxy must not be the sole
 * authorisation layer, so every admin page and server action calls requireOperator() again
 * (src/server/admin/session.ts); a test fails if one forgets.
 */
export async function proxy(request: NextRequest) {
  const result = await getAdminAuthorizer()(request.headers);
  if (!result.ok) {
    // Reason code only: never the token, never the email.
    getLogger().warn({ reason: result.reason, path: request.nextUrl.pathname }, "admin access refused");
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/admin", "/admin/:path*"] };
