import type { WorkerEnv } from "@/lib/env";
import type { ChannelSenders } from "@/modules/delivery";
import type { EmailSender } from "@/modules/alerts";
import { createTwilioSender } from "./twilio";
import { createWebhookSender } from "./webhook";

export { createTwilioSender, computeTwilioSignature, verifyTwilioSignature } from "./twilio";
export { createWebhookSender } from "./webhook";
export { isPublicAddress } from "./ssrf";

/** Where Twilio reports delivery: the PUBLIC host (APP_URL), not the Access-protected admin host. */
export const twilioCallbackUrl = (appUrl: string): string => `${appUrl.replace(/\/$/, "")}/api/webhooks/twilio`;

/** The ONE place the delivery channels are chosen (called from the worker's composition root). A channel with no settings is simply absent. */
export function createChannelSenders(env: WorkerEnv, email: EmailSender): ChannelSenders {
  const twilio = env.TWILIO_ACCOUNT_SID && env.TWILIO_API_KEY_SID && env.TWILIO_API_KEY_SECRET && env.TWILIO_MESSAGING_SERVICE_SID
    ? createTwilioSender({
        accountSid: env.TWILIO_ACCOUNT_SID, apiKeySid: env.TWILIO_API_KEY_SID, apiKeySecret: env.TWILIO_API_KEY_SECRET,
        messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID, statusCallbackUrl: twilioCallbackUrl(env.APP_URL), baseUrl: env.TWILIO_BASE_URL,
      })
    : undefined;
  return { email, sms: twilio, webhook: createWebhookSender({ allowLoopbackForTests: env.WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS }) };
}
