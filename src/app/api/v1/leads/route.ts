import { handleSubmitLead } from "@/server/handlers/submit-lead";
import { getContainer } from "@/server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSubmitLead(request, getContainer().submitLead);
}
