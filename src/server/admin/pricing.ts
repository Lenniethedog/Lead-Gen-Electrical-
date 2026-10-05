import "server-only";
import { randomUUID } from "node:crypto";
import { clientIdSchema } from "@/modules/clients";
import { formFields } from "@/modules/inbox/schemas";
import { parsePricingRule, type PricingFailure } from "@/modules/pricing";
import { getContainer } from "../container";
import { requireOperator } from "./session";

/** Data-access layer for flat pricing rules. */

export async function loadPricing() {
  await requireOperator();
  return getContainer().pricing.list();
}

export type PricingOutcome =
  | { ok: true; notice: "price_set" | "price_ended" }
  | { ok: false; error: PricingFailure | "invalid_request"; fieldErrors?: Record<string, string> };

export async function setPriceFromForm(form: FormData): Promise<PricingOutcome> {
  const operator = await requireOperator();
  const parsed = parsePricingRule(formFields(form));
  if (!parsed.ok) return { ok: false, error: "invalid_request", fieldErrors: parsed.errors };
  const result = await getContainer().pricing.setPrice({ operator, rule: parsed.value, requestId: randomUUID() });
  return result.ok ? { ok: true, notice: "price_set" } : { ok: false, error: result.code };
}

export async function endPriceFromForm(form: FormData): Promise<PricingOutcome> {
  const operator = await requireOperator();
  const id = clientIdSchema.safeParse(form.get("ruleId"));
  if (!id.success) return { ok: false, error: "invalid_request" };
  const result = await getContainer().pricing.end({ operator, ruleId: id.data, requestId: randomUUID() });
  return result.ok ? { ok: true, notice: "price_ended" } : { ok: false, error: result.code };
}
