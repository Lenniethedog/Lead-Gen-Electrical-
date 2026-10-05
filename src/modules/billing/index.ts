/** Public surface of the billing module (stage 6, slice 3): credit, charges and the reconciliation that proves they add up. */
export { createBillingService, type BillingFailure, type BillingOverview, type BillingResult, type BillingService, type BillingServiceDeps } from "./service";
export { parseCreditAmount, parseCreditPosting, type CreditPostingInput } from "./schemas";
export type { ChargeRow, LedgerRow } from "./repo";
export { getBillingHealth, type BillingProblem } from "./health";
