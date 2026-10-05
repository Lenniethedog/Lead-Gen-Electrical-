/**
 * Public surface of the delivery module (stage 5): tells a business about its lead, automatically, by email, text message and signed
 * webhook. The notification rows are written by a trigger in the assignment's own transaction (migration 0006), delivered by the worker,
 * and protected by a lease, retries with backoff, a reconciler, and /api/pipeline.
 */
export { createDeliveryService, type DeliveryService, type DeliveryServiceConfig, type DeliveryServiceDeps, type DeliverySummary, type ProviderEventResult, type RetryResult } from "./service";
export { buildSmsBody, buildWebhookBody, WEBHOOK_EVENT, type DeliveryData } from "./messages";
export type { ChannelSenders, SendResult, SmsMessage, SmsSender, WebhookMessage, WebhookSender } from "./ports";
export { NOTIFICATIONS_CHANNEL, getDeliveryHealth, type Channel, type DeliveryHealth, type DeliveryProblem, type NotificationStatus, type NotificationView, type ProblemRow } from "./repo";
