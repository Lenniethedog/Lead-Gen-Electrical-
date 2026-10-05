/** Public surface of the clientauth module: how a business's people sign in (stage 6, decisions D43-D44). */
export { createClientAuthService, type ClientAuthService, type ClientAuthServiceDeps, type ClientSession, type StaffFailure, type StaffResult } from "./service";
export type { ClientUserRecord } from "./repo";
export { looksLikeSecret } from "./tokens";
/** Clears out sign-in links and sessions that ended more than a week ago. Idempotent; run by the worker. */
export { deleteStaleCredentials as cleanUpClientCredentials } from "./repo";
