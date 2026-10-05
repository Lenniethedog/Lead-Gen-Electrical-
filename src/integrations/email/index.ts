import type { AppEnvironment } from "@/lib/env";
import type { EmailSender } from "@/modules/alerts/ports";
import { createConsoleSender } from "./console";
import { createResendSender } from "./resend";

export { createConsoleSender } from "./console";
export { createResendSender, type ResendSenderOptions } from "./resend";

/** What choosing a provider needs: both the worker's and the web process's environment have it. */
export interface EmailSettings {
  APP_ENV: AppEnvironment;
  EMAIL_PROVIDER: "console" | "resend";
  RESEND_API_KEY?: string | undefined;
  EMAIL_FROM?: string | undefined;
  RESEND_BASE_URL?: string | undefined;
}

/** The ONE place the email provider is chosen (called from the worker's and the web process's composition roots). */
export function createEmailSender(env: EmailSettings): EmailSender {
  if (env.EMAIL_PROVIDER === "resend") {
    // The environment schema guarantees both; the check keeps the types honest and fails loudly.
    if (!env.RESEND_API_KEY || !env.EMAIL_FROM) throw new Error("EMAIL_PROVIDER=resend needs RESEND_API_KEY and EMAIL_FROM");
    return createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM, baseUrl: env.RESEND_BASE_URL });
  }
  if (env.APP_ENV === "staging" || env.APP_ENV === "production") {
    throw new Error(`the console email provider is not allowed in ${env.APP_ENV}`);
  }
  return createConsoleSender();
}
