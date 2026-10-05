/** Public surface of the clientauth module: how a business's people sign in (stage 6, decisions D43-D44). */
export { createClientAuthService, type ClientAuthService, type ClientAuthServiceDeps, type ClientSession, type StaffFailure, type StaffResult } from "./service";
export type { ClientUserRecord } from "./repo";
export { looksLikeSecret } from "./tokens";
