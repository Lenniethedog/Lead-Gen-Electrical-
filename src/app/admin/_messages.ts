import { REASON_TEXT } from "@/modules/coverage/reasons";

/** Plain-language messages for every outcome code the admin screens can show. One place, so wording is consistent. */
export const NOTICES: Record<string, string> = {
  // clients
  created: "Client created. Add what they do and where they cover, then make them active.",
  saved: "Saved.",
  status_changed: "Status changed.",
  services_saved: "Services saved.",
  rule_added: "Coverage rule added.",
  rule_removed: "Coverage rule removed.",
  // people who can sign in (stage 6)
  user_invited: "Invited. They have been emailed a sign-in link (it works once, for 15 minutes).",
  user_link_sent: "A new sign-in link has been emailed.",
  user_disabled: "Disabled. They are signed out everywhere and cannot sign in.",
  user_enabled: "Enabled. They can ask for a sign-in link again.",
  user_role_changed: "Role changed.",
  // pricing
  price_set: "Price saved. It applies to leads assigned from now on; existing assignments keep their price.",
  price_ended: "That price rule has ended.",
  // assignments
  assigned: "Lead assigned. Send the message below to the business, then click “I've sent it”.",
  sent: "Marked as sent.",
  cancelled: "Taken back. The lead is waiting for you again.",
  reassigned: "Moved to the new business. Send them the message below.",
  // routing
  routing_on: "Automatic routing is ON. Leads that arrive from now on are assigned to a business within seconds. You still send each one.",
  routing_off: "Automatic routing is OFF. Nothing is routed automatically; leads wait for you again.",
  routing_rule_saved: "Rule saved.",
  routing_rule_moved: "Order changed.",
  routing_age_saved: "Age limit saved.",
  // client routing preferences
  routing_prefs_saved: "Routing preferences saved.",
  hours_saved: "Working hours saved.",
  pause_added: "Pause added.",
  pause_removed: "Pause removed.",
  // delivery
  delivery_saved: "Saved how they are told.",
  delivery_retried: "Back in the queue: it will be tried again within seconds.",
  // privacy
  withdrawn: "Consent withdrawn. The lead is closed and the person will not be contacted. Tell the businesses listed below.",
  already_withdrawn: "Consent was already withdrawn for this lead.",
  erased: "Personal data erased. Tell the businesses listed below to delete theirs.",
  already_erased: "This lead's personal data was already erased.",
};

export const ERRORS: Record<string, string> = {
  invalid_request: "That request was not valid. Nothing was changed.",
  not_found: "That record no longer exists.",
  not_ready: "That would leave an active client unable to receive any lead (it needs at least one service and one “include” coverage rule). Nothing was changed.",
  reason_required: "Choose a reason. Nothing was changed.",
  invalid_reason: "Choose one of the listed reasons. Nothing was changed.",
  duplicate_rule: "The client already has exactly that rule.",
  unknown_area: "Choose an area from the list.",
  unknown_postcode: "That postcode is not in the postcode directory.",
  unknown_service: "Choose a service from the list.",
  same_status: "The client already has that status.",
  // assignments
  lead_erased: "This lead's personal data has been erased, so it cannot be handed to anyone.",
  lead_held: "This lead is held for review. Approve it first.",
  already_assigned: "Someone already assigned this lead. Reload to see who holds it.",
  lead_not_assignable: "This lead cannot be assigned in its current state.",
  consent_withdrawn: "The consumer withdrew consent: this lead cannot be handed to a business.",
  no_consent_to_share: "The consumer did not consent to their details being passed to a business.",
  suppressed: "The consumer has asked us to stop since they enquired, so this lead cannot be handed over.",
  client_not_found: "That business no longer exists.",
  client_not_active: "That business is not active. Make it active first.",
  not_covered: "That business does not cover this postcode. Tick the box to hand it over anyway.",
  price_required: "No price rule matches this lead: enter the price for this one.",
  same_client: "That business already holds this lead.",
  not_cancellable: "That assignment can no longer be changed.",
  not_notifiable: "That assignment is not waiting to be sent.",
  forbidden: "Only an owner can do that.",
  sms_needs_phone: "Add a phone number to this business before turning on text messages.",
  webhook_needs_secret: "Generate a signing secret before turning on the webhook.",
  secrets_unavailable: "Webhook secrets cannot be created here: the server has no delivery encryption key.",
  not_retryable: "That delivery is not failed any more, so there is nothing to retry.",
  assignment_ended: "That lead was taken back from the business, so it cannot be sent to them. Hand it to someone else.",
  stale: "Someone else changed that while you were looking at it. Reload the page and try again.",
  invalid_config: "That setting is not valid. Nothing was changed.",
  cannot_move: "That cannot be moved any further.",
  invalid_age: "Enter a whole number of hours from 1 to 168.",
  overlapping_pause: "That pause could not be saved.",
  email_taken: "That email address already belongs to someone who can sign in (at this or another business). Each address can belong to one business.",
  invalid_input: "Enter a name and a valid email address.",
  already_in_state: "That has already been done.",
  no_consent_record: "No consent record exists for this lead.",
};

export const COVERAGE_REASON_TEXT = REASON_TEXT;
