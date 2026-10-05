import { createPipelineHandler } from "@/server/handlers/pipeline";
import { getContainer } from "@/server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalForHandler = globalThis as typeof globalThis & { __leadgenPipelineHandler?: () => Promise<Response> };

export function GET(): Promise<Response> {
  // One handler per process, so its short-lived cache is actually shared between requests.
  globalForHandler.__leadgenPipelineHandler ??= createPipelineHandler(getContainer().pipeline);
  return globalForHandler.__leadgenPipelineHandler();
}
