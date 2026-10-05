import { handleReady } from "@/server/handlers/health";
import { getContainer } from "@/server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Promise<Response> {
  return handleReady(getContainer().ready);
}
