/** Public surface of the pricing module (stage 3): flat prices, most specific rule wins, history immutable. */
export { createPricingService, type PricingFailure, type PricingResult, type PricingService, type PricingServiceDeps } from "./service";
export { resolvePrice, type LeadPricingFacts, type PricingRuleRow, type ResolvedPrice, type SaleType } from "./repo";
export { MAX_PRICE_PENCE, formatPence, parsePoundsToPence, parsePricingRule, type PricingRuleInput } from "./schemas";
