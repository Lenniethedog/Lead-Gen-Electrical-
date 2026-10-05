/** Public surface of the coverage module (stage 3): which clients may receive a lead, and why. */
export { REASON_TEXT } from "./reasons";
export {
  explainCoverage,
  findEligibleClients,
  type ClientVerdict,
  type CoverageExplanation,
  type CoverageQuery,
  type MatchedRule,
  type NotEligibleReason,
  type SaleType,
} from "./repo";
export { createCoverageService, type CoverageService, type CoverageServiceDeps, type CoverageTesterData } from "./service";
