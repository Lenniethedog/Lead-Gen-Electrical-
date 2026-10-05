import type { EmailSender, SendResult } from "@/modules/alerts";

/**
 * What the delivery service needs from the outside world. Adapters live in src/integrations/delivery; the domain code imports no vendor
 * SDK and does no network I/O of its own, so a provider can be swapped or faked without touching the retry logic.
 * Every sender returns a result for provider-level problems (a throw is treated as retryable) and honours the abort signal.
 */
export type { SendResult };

export interface SmsMessage {
  /** E.164. */
  to: string;
  body: string;
  /** For correlating the provider's status callback; the provider has no idempotency, so a retry after "accepted but we never heard" can send twice. */
  notificationId: string;
}
export interface SmsSender {
  send(message: SmsMessage, context: { signal: AbortSignal }): Promise<SendResult>;
}

export interface WebhookMessage {
  /** https, from the business's own settings; the sender re-validates it and refuses private destinations. */
  url: string;
  /** The plaintext signing secret (decrypted just before sending, never logged). */
  secret: string;
  body: string;
  /** The notification id: the receiver's de-duplication key (X-Leadgen-Delivery). */
  deliveryId: string;
  event: string;
}
export interface WebhookSender {
  send(message: WebhookMessage, context: { signal: AbortSignal }): Promise<SendResult>;
}

export interface ChannelSenders {
  email: EmailSender;
  /** Absent when no SMS provider is configured: an SMS notification then fails as `channel_not_configured` (retryable, and reported). */
  sms?: SmsSender | undefined;
  webhook?: WebhookSender | undefined;
}
