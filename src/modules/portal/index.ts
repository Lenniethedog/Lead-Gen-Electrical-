/** Public surface of the portal module: what a business's signed-in people see (stage 6). */
export { createPortalService, type PortalService, type PortalServiceDeps } from "./service";
export type { LeadDetailRow, LeadRow } from "./repo";
export { parseContactAttempt, parseJobValue, type ContactAttemptInput } from "./schemas";
export type { ContactAttemptRow } from "./repo";
