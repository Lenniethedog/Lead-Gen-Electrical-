/** Public surface of the inbox module: what an operator sees and does (stage 2). */
export { ensureOperator } from "./repo";
export { createInboxService, type InboxService, type InboxServiceDeps } from "./service";
export { INBOX_VIEWS } from "./types";
export type { ActionFailure, ActionResult, InboxRow, InboxView, LeadDetail, Operator, TimelineEntry } from "./types";
