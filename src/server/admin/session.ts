import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { getLogger } from "@/lib/logger";
import { ensureOperator, type Operator } from "@/modules/inbox";
import { getDb } from "../db";
import { getAdminAuthorizer } from "./authorizer";

/**
 * The operator making this request, or the page does not exist (404).
 *
 * EVERY admin page and EVERY server action must call this first. The proxy has already refused
 * unauthenticated requests, but a server action is reachable by a direct POST, so authorisation is
 * re-checked where the data is touched (node_modules/next/dist/docs/01-app/02-guides/data-security.md).
 * `cache` makes repeated calls within one request free.
 */
export const requireOperator = cache(async (): Promise<Operator> => {
  const result = await getAdminAuthorizer()(await headers());
  if (!result.ok) {
    getLogger().warn({ reason: result.reason }, "admin access refused (data layer)");
    notFound();
  }
  return ensureOperator(getDb(), result.email, result.role);
});
