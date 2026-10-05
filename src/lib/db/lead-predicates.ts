import { sql } from "kysely";
import { LEAD_EVENT } from "@/config/lead-events";

/**
 * SQL fragments that mean the same thing everywhere they are used. `l` must be the alias of the `leads` table in the query.
 *
 * "Needs a person" is decided in ONE place because three things must agree on it: the inbox's "Needs action" list, the reminder email
 * that nags about a lead nobody has dealt with, and the health check that shouts when an alert for such a lead could not be sent.
 */

/** A person marked the lead handled (an event, not a status: a lead sold by hand has no assignment to say so). */
export const handledByAPerson = sql<boolean>`exists (select 1 from lead_events e where e.lead_id = l.id and e.type = ${LEAD_EVENT.handled})`;

/** Handed to a business but not yet sent to them (stage 4: the router assigns, a person still sends). */
export const hasUnsentAssignment = sql<boolean>`exists (select 1 from lead_assignments a where a.lead_id = l.id and a.status = 'reserved')`;

/**
 * Held (decide), new or unroutable and nobody has dealt with it (hand it over, or mark it handled), or assigned and not yet sent.
 * A lead the router is working on, a handled lead, a sent lead and a closed lead do not need a person.
 */
export const needsAPerson = sql<boolean>`(
  l.status = 'held'
  or (l.status in ('new', 'unroutable') and not ${handledByAPerson})
  or (l.status = 'assigned' and ${hasUnsentAssignment}))`;
