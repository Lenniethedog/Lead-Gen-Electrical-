/**
 * What the alert service needs from an email provider. Adapters live in src/integrations/email;
 * the domain code never imports a vendor SDK, so a provider can be swapped (or faked in tests)
 * without touching the retry logic.
 */
export interface EmailMessage {
  to: readonly string[];
  subject: string;
  /** Plain text only: nothing to escape, nothing to render, no tracking pixels. */
  text: string;
  /**
   * Stable for the lifetime of one alert (NOT per attempt). Providers that honour it return the
   * original result for a repeat, which is what makes "the worker died after the provider accepted
   * the message" harmless: the retry cannot send a second email.
   */
  idempotencyKey: string;
}

export type SendResult =
  | { outcome: "accepted"; providerMessageId?: string }
  /** Worth trying again later: network failure, timeout, 429, 5xx, credentials that may yet be fixed. */
  | { outcome: "retryable_failure"; errorCode: string; httpStatus?: number }
  /** Retrying cannot help (invalid recipient or sender, malformed request). */
  | { outcome: "permanent_failure"; errorCode: string; httpStatus?: number };

export interface EmailSender {
  /** Must not throw for provider-level problems; return a failure result. A throw is treated as retryable. */
  send(message: EmailMessage, context: { signal: AbortSignal }): Promise<SendResult>;
}
