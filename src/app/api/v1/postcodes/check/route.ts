import { handleCheckPostcode } from "@/server/handlers/check-postcode";
import { getContainer } from "@/server/container";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleCheckPostcode(request, getContainer().checkPostcode);
}
