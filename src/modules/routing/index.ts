/** Public surface of the routing module (stage 4): who gets a lead automatically, and why. */
export { createRoutingService, BLOCKER_TEXT, type Analysis, type Blocker, type CandidateRecord, type Explanation, type RouteResult, type RoutingFailure, type RoutingResult, type RoutingService, type RoutingServiceDeps, type RunDetail } from "./service";
export { EXCLUSION_TEXT, decide, evaluateClient, isOpen, rank, type ClientFacts, type ClientVerdict, type Decision, type ExclusionCode, type RankedVerdict, type RankingKeys, type WorkingWindow } from "./engine";
export { DEFAULT_RULES, RULE_INFO, RULE_KIND, RULE_TYPES, RulesConfigError, compileRules, parseRuleConfig, type CompiledRules, type RuleKind, type RuleRow, type RuleSnapshot, type RuleType } from "./rules";
export { ROUTING_CHANNEL, getRoutingHealth, type RoutingHealth, type RoutingProblem, type RoutingSettings, type RoutingStats, type RunOutcome, type StoredRun } from "./repo";
