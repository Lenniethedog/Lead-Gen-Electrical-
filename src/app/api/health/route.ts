import { handleHealth } from "@/server/handlers/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return handleHealth();
}
