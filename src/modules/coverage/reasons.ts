/** Wording for why a client is not eligible. Pure, so the admin UI can import it without pulling in the database code. */
import type { NotEligibleReason } from "./repo";

export const REASON_TEXT: Record<NotEligibleReason, string> = {
  client_not_active: "The client is not active",
  service_not_offered: "The client does not offer this service",
  sale_type_not_accepted: "The client does not accept this type of lead",
  no_include_rule_matches: "No coverage rule includes this postcode",
  excluded_by_rule: "An exclusion rule matches this postcode",
};
