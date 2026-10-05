/** Public surface of the clients module (stage 3): the businesses that buy leads, what they do and where they cover. */
export { createClientService, type ClientFailure, type ClientResult, type ClientService, type ClientServiceDeps } from "./service";
export type { ClientAssignmentRow, ClientDetail, ClientListRow, ClientRow, CoverageRuleRow } from "./repo";
export {
  CLIENT_STATUSES,
  CLIENT_STATUS_REASONS,
  COVERAGE_KINDS,
  COVERAGE_MODES,
  MAX_RADIUS_MILES,
  clientIdSchema,
  describeRule,
  parseClientInput,
  parseCoverageRule,
  serviceSlugsSchema,
  statusNeedsReason,
  type ClientInput,
  type ClientStatus,
  type CoverageKind,
  type CoverageMode,
  type CoverageRuleInput,
  type FieldErrors,
  type FormState,
  type Parsed,
} from "./schemas";
export {
  PAUSE_REASONS,
  PAUSE_REASON_CODES,
  WEEKDAYS,
  parsePause,
  parseRoutingPreferences,
  parseWorkingHours,
  type PauseInput,
  type PauseReason,
  type RoutingPreferencesInput,
  type WorkingWindowInput,
} from "./routing-schemas";
export type { PauseRow, RoutingPreferences } from "./routing-repo";
export { DELIVERY_MODES, parseDeliverySettings, validateWebhookUrl, type DeliveryMode, type DeliverySettingsInput } from "./delivery-schemas";
export type { DeliverySettings } from "./routing-repo";
