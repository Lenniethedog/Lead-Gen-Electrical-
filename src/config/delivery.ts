/** Delivery policy (stage 5). Numbers, not wiring: tested and explained in docs/03-routing-and-delivery.md. */
export const DELIVERY_POLICY = {
  /** /api/pipeline: a notification that was due this long ago and still is not sent. */
  overdueSeconds: 120,
  /** /api/pipeline: only failures this recent are reported (an old one nobody acted on is not a live incident). */
  lookbackHours: 72,
  /** A webhook call is abandoned after this long (the lease is far longer, so nobody else takes the notification meanwhile). */
  webhookTimeoutMs: 8_000,
  /** Most of a webhook's response body that is read. The body is never stored: only the status code is kept. */
  webhookMaxResponseBytes: 65_536,
  /** An SMS body is kept to two segments of plain characters (a longer one costs more and may be cut). */
  smsMaxChars: 300,
  /** Twilio callback bodies larger than this are refused before the signature is even computed. */
  callbackMaxBytes: 16_384,
} as const;

/** The channels a business can be told through. Order is the order they are listed in, not a fallback order: every enabled channel is sent. */
export const CHANNELS = ["email", "sms", "webhook"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = { email: "Email", sms: "Text message", webhook: "Webhook" };
