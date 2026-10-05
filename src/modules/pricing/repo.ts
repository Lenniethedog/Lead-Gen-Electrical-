import { sql } from "kysely";
import type { Database } from "@/lib/db/client";
import type { UrgencyLevel } from "@/lib/db/schema";

/** All SQL for flat pricing rules. Takes a `Database` (possibly a transaction). */

export type SaleType = "exclusive" | "shared";

export interface LeadPricingFacts {
  verticalId: number;
  serviceTypeId: number;
  /** The lead's outward code (kept after erasure), used to match an area-specific rule. */
  postcodeOutward: string;
  urgency: UrgencyLevel;
  saleType: SaleType;
}

export interface ResolvedPrice {
  ruleId: string;
  pricePence: number;
}

/**
 * The price a lead would get: the MOST SPECIFIC matching rule (a rule that names a service, an area and an urgency beats one that
 * names fewer), then higher priority, then the newest. Only rules valid at `at` count. No match returns undefined: the caller must
 * ask a human rather than invent a price.
 *
 * "Now" is the DATABASE's now(), never the JS clock: JavaScript dates have millisecond resolution and PostgreSQL's have
 * microseconds, so a rule created (or ended) within the same millisecond would be misjudged as not yet started (or still valid).
 */
export async function resolvePrice(db: Database, facts: LeadPricingFacts, at?: Date): Promise<ResolvedPrice | undefined> {
  const when = at ? sql`${at}::timestamptz` : sql`now()`;
  const { rows } = await sql<{ id: string; price_pence: number }>`
    select p.id, p.price_pence
      from pricing_rules p
     where p.vertical_id = ${facts.verticalId}
       and p.sale_type = ${facts.saleType}::sale_type
       and (p.service_type_id is null or p.service_type_id = ${facts.serviceTypeId})
       and (p.urgency is null or p.urgency = ${facts.urgency}::urgency_level)
       and (p.service_area_id is null or exists (
             select 1 from service_area_districts d where d.service_area_id = p.service_area_id and d.outward = ${facts.postcodeOutward}))
       and p.valid_during @> ${when}
     order by ((p.service_type_id is not null)::int + (p.service_area_id is not null)::int + (p.urgency is not null)::int) desc,
              p.priority desc, lower(p.valid_during) desc, p.created_at desc, p.id
     limit 1`.execute(db);
  const row = rows[0];
  return row ? { ruleId: row.id, pricePence: row.price_pence } : undefined;
}

export interface PricingRuleRow {
  id: string;
  serviceTypeId: number | null;
  serviceLabel: string | null;
  serviceAreaId: number | null;
  areaName: string | null;
  urgency: UrgencyLevel | null;
  saleType: SaleType;
  pricePence: number;
  validFrom: Date;
  /** null while the rule is current. */
  validTo: Date | null;
  state: "current" | "ended" | "future";
}

export async function listRules(db: Database, verticalId: number): Promise<PricingRuleRow[]> {
  const { rows } = await sql<{
    id: string; service_type_id: number | null; service_label: string | null; service_area_id: number | null; area_name: string | null;
    urgency: UrgencyLevel | null; sale_type: SaleType; price_pence: number; valid_from: Date; valid_to: Date | null; state: PricingRuleRow["state"];
  }>`
    select p.id, p.service_type_id, st.label as service_label, p.service_area_id, sa.name as area_name, p.urgency, p.sale_type, p.price_pence,
           lower(p.valid_during) as valid_from, upper(p.valid_during) as valid_to,
           (case when upper(p.valid_during) is not null and upper(p.valid_during) <= now() then 'ended'
                 when lower(p.valid_during) > now() then 'future' else 'current' end) as state
      from pricing_rules p
      left join service_types st on st.id = p.service_type_id
      left join service_areas sa on sa.id = p.service_area_id
     where p.vertical_id = ${verticalId}
     order by (upper(p.valid_during) is null or upper(p.valid_during) > now()) desc, p.created_at desc`.execute(db);
  return rows.map((row) => ({
    id: row.id,
    serviceTypeId: row.service_type_id,
    serviceLabel: row.service_label,
    serviceAreaId: row.service_area_id,
    areaName: row.area_name,
    urgency: row.urgency,
    saleType: row.sale_type,
    pricePence: row.price_pence,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    state: row.state,
  }));
}

export interface NewRule {
  verticalId: number;
  serviceTypeId: number | null;
  serviceAreaId: number | null;
  urgency: UrgencyLevel | null;
  saleType: SaleType;
  pricePence: number;
  createdBy: string;
}

/**
 * Serialises price changes for ONE scope for the rest of the transaction, so two operators setting the same price at the same
 * moment queue up instead of both ending "the current rule" and both inserting a new one. Different scopes never contend.
 */
export async function lockPricingScope(db: Database, scope: Omit<NewRule, "pricePence" | "createdBy">): Promise<void> {
  const key = `pricing:${scope.verticalId}:${scope.serviceTypeId ?? "-"}:${scope.serviceAreaId ?? "-"}:${scope.urgency ?? "-"}:${scope.saleType}`;
  await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(db);
}

/**
 * The moment a price change takes effect, read AFTER the scope lock is held. `now()` would be the time the transaction BEGAN, and a transaction that began
 * earlier can win the lock later: it would stamp its rule BEFORE the one it is replacing, fail to end it, and leave two current rules (found by the 8-way race
 * test under load). `clock_timestamp()` moves forward in lock order. Kept as text so microseconds survive the round trip.
 */
export async function pricingMoment(db: Database): Promise<string> {
  const { rows } = await sql<{ at: string }>`select clock_timestamp()::text as at`.execute(db);
  return rows[0]!.at;
}

/** Ends every CURRENT rule with exactly this scope (service, area, urgency, sale type) as of `at`. Returns what it ended. */
export async function endRulesWithScope(db: Database, scope: Omit<NewRule, "pricePence" | "createdBy">, at: string): Promise<Array<{ id: string; pricePence: number }>> {
  const { rows } = await sql<{ id: string; price_pence: number }>`
    update pricing_rules
       set valid_during = tstzrange(lower(valid_during), ${at}::timestamptz)
     where vertical_id = ${scope.verticalId}
       and sale_type = ${scope.saleType}::sale_type
       and service_type_id is not distinct from ${scope.serviceTypeId}
       and service_area_id is not distinct from ${scope.serviceAreaId}
       and urgency is not distinct from ${scope.urgency}::urgency_level
       and upper(valid_during) is null and lower(valid_during) < ${at}::timestamptz
    returning id, price_pence`.execute(db);
  return rows.map((row) => ({ id: row.id, pricePence: row.price_pence }));
}

export async function insertRule(db: Database, rule: NewRule, at: string): Promise<string> {
  const row = await db
    .insertInto("pricing_rules")
    .values({
      vertical_id: rule.verticalId,
      service_type_id: rule.serviceTypeId,
      service_area_id: rule.serviceAreaId,
      urgency: rule.urgency,
      sale_type: rule.saleType,
      price_pence: rule.pricePence,
      valid_during: sql<string>`tstzrange(${at}::timestamptz, null)`,
      created_by: rule.createdBy,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Ends one current rule as of now. Returns it, or undefined if it is unknown or already ended. */
export async function endRule(db: Database, ruleId: string): Promise<{ id: string; pricePence: number } | undefined> {
  const { rows } = await sql<{ id: string; price_pence: number }>`
    update pricing_rules set valid_during = tstzrange(lower(valid_during), clock_timestamp())
     where id = ${ruleId} and upper(valid_during) is null and lower(valid_during) < clock_timestamp()
    returning id, price_pence`.execute(db);
  return rows[0] ? { id: rows[0].id, pricePence: rows[0].price_pence } : undefined;
}
