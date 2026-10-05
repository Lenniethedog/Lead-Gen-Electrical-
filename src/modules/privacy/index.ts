/** Public surface of the privacy module (stage 3): erase a lead, withdraw consent, suppress, and re-apply erasures after a restore. */
export { createPrivacyService, type PrivacyFailure, type PrivacyResult, type PrivacyService, type PrivacyServiceDeps } from "./service";
export { normaliseForSuppression, suppressionHmac, type SuppressionKind } from "./suppression";
export type { HolderNotice } from "./repo";
export { ERASURE_LOG_MESSAGE, extractErasedLeadIds } from "./replay";
