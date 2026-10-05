import { getContainer } from "@/server/container";
import { createTwilioCallbackHandler } from "@/server/handlers/twilio-callback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalForHandler = globalThis as typeof globalThis & { __leadgenTwilioHandler?: (request: Request) => Promise<Response> };

/** Twilio's delivery reports. Public, and verified by signature: see the handler. */
export function POST(request: Request): Promise<Response> {
  globalForHandler.__leadgenTwilioHandler ??= createTwilioCallbackHandler(getContainer().twilioCallback);
  return globalForHandler.__leadgenTwilioHandler(request);
}

// Any other method is answered 405 by the framework, with no body.
