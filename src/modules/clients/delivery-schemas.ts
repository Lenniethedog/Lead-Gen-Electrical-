import type { FieldErrors, Parsed } from "./schemas";

/** How a business wants to be told about its leads (stage 5). Pure parsing, shared by the form and the server. */
export const DELIVERY_MODES = ["manual", "automatic"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

export interface DeliverySettingsInput {
  mode: DeliveryMode;
  email: boolean;
  sms: boolean;
  webhook: boolean;
  /** https URL, or null for none. */
  webhookUrl: string | null;
}

const ticked = (value: string | undefined) => value === "on" || value === "true";

/** A webhook URL must be https, have a host, carry no credentials, and not point straight at a private address. (The sender checks again after DNS.) */
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: "Enter the full web address, starting https://" };
  }
  if (url.protocol !== "https:") return { ok: false, message: "The address must start with https:// (plain http is not allowed)" };
  if (url.username || url.password) return { ok: false, message: "Leave the user name and password out of the address" };
  if (raw.trim().length > 500) return { ok: false, message: "That address is too long" };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, message: "That address is not on the public internet" };
  if (/^[0-9.]+$/.test(host) || host.includes(":")) return { ok: false, message: "Use a web address with a name, not a number" };
  return { ok: true, url: url.toString() };
}

export function parseDeliverySettings(fields: Record<string, string | undefined>): Parsed<DeliverySettingsInput> {
  const errors: FieldErrors = {};
  const mode = DELIVERY_MODES.find((candidate) => candidate === fields.deliveryMode);
  if (!mode) errors.deliveryMode = "Choose manual or automatic";
  const email = ticked(fields.notifyEmail);
  const sms = ticked(fields.notifySms);
  const webhook = ticked(fields.notifyWebhook);
  const rawUrl = (fields.webhookUrl ?? "").trim();
  let webhookUrl: string | null = null;
  if (rawUrl !== "") {
    const checked = validateWebhookUrl(rawUrl);
    if (checked.ok) webhookUrl = checked.url;
    else errors.webhookUrl = checked.message;
  } else if (webhook) errors.webhookUrl = "Enter the webhook address, or untick the webhook";
  if (mode === "automatic" && !email && !sms && !webhook) errors.deliveryMode = "Choose at least one way to tell them, or choose manual";
  if (Object.keys(errors).length > 0 || !mode) return { ok: false, errors };
  return { ok: true, value: { mode, email, sms, webhook, webhookUrl } };
}
