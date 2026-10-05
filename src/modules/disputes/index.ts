/** Public surface of the disputes module (stage 6, slice 4): a business reports a problem with a lead, staff decide, the money follows. */
export { createDisputeService, type DisputeFailure, type DisputeResult, type DisputeService, type DisputeServiceDeps } from "./service";
export { parseDecision, parseDispute, type Decision, type DisputeInput } from "./schemas";
export type { DisputeRow } from "./repo";
