import { sql } from "kysely";
import type { Database } from "@/lib/db/client";
import type { ClientStatus, CoverageKind, CoverageMode } from "@/modules/clients";
import { describeRule } from "@/modules/clients";

/**
 * Which clients may receive a lead? Eligibility = the client is active, offers the service, accepts the sale type, AND any active
 * INCLUDE rule matches the lead's postcode AND no active EXCLUDE rule matches.
 *
 * The matching CTE is written ONCE and used by both the production query (findEligibleClients) and the explainer behind the
 * coverage tester, so what the tester shows is what routing will do. Each rule kind is its own UNION ALL branch so that each
 * uses its own partial index (csa_outward_idx, csa_sector_idx, csa_area_idx, csa_radius_idx); do not collapse them into one
 * OR-ed predicate. Distance is haversine in metres (mean Earth radius 6,371,000 m), evaluated only for radius rules, of which
 * there are few: the clients are the small set, not the postcodes.
 */
export type SaleType = "exclusive" | "shared";

export interface CoverageQuery {
  /** Canonical form, "BR6 0AA". */
  postcode: string;
  verticalId: number;
  serviceTypeId: number;
  saleType: SaleType;
}

const matchingRulesCte = (postcode: string) => sql`
  geo AS (
    SELECT postcode, outward, sector, lat, lng FROM postcodes WHERE postcode = ${postcode}
  ),
  matching_rules AS (
    SELECT a.id AS rule_id, a.client_id, a.mode FROM client_service_areas a, geo g
     WHERE a.kind = 'outward' AND a.active AND a.outward = g.outward
    UNION ALL
    SELECT a.id, a.client_id, a.mode FROM client_service_areas a, geo g
     WHERE a.kind = 'sector' AND a.active AND a.sector = g.sector
    UNION ALL
    SELECT a.id, a.client_id, a.mode FROM client_service_areas a, geo g
     WHERE a.kind = 'postcode_prefix' AND a.active AND g.postcode LIKE a.postcode_prefix || '%'
    UNION ALL
    SELECT a.id, a.client_id, a.mode FROM client_service_areas a, geo g
     WHERE a.kind = 'area' AND a.active
       AND EXISTS (SELECT 1 FROM service_area_districts d WHERE d.service_area_id = a.service_area_id AND d.outward = g.outward)
    UNION ALL
    SELECT a.id, a.client_id, a.mode
      FROM client_service_areas a
      JOIN geo g ON g.lat IS NOT NULL
      JOIN postcodes centre ON centre.postcode = a.center_postcode AND centre.lat IS NOT NULL
     WHERE a.kind = 'radius' AND a.active
       AND 2 * 6371000 * asin(sqrt(
             power(sin(radians(g.lat - centre.lat) / 2), 2)
             + cos(radians(centre.lat)) * cos(radians(g.lat)) * power(sin(radians(g.lng - centre.lng) / 2), 2)
           )) <= a.radius_m
  )`;

/** The production query: ids of clients that may receive this lead, by name. */
export async function findEligibleClients(db: Database, query: CoverageQuery): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await sql<{ id: string; name: string }>`
    WITH ${matchingRulesCte(query.postcode)}
    SELECT c.id, c.name
      FROM clients c
     WHERE c.vertical_id = ${query.verticalId}
       AND c.status = 'active'
       AND c.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM client_services cs WHERE cs.client_id = c.id AND cs.service_type_id = ${query.serviceTypeId})
       AND ((${query.saleType}::sale_type = 'exclusive' AND c.accepts_exclusive) OR (${query.saleType}::sale_type = 'shared' AND c.accepts_shared))
       AND EXISTS     (SELECT 1 FROM matching_rules r WHERE r.client_id = c.id AND r.mode = 'include')
       AND NOT EXISTS (SELECT 1 FROM matching_rules r WHERE r.client_id = c.id AND r.mode = 'exclude')
     ORDER BY c.name, c.id`.execute(db);
  return rows;
}

export type NotEligibleReason =
  | "client_not_active"
  | "service_not_offered"
  | "sale_type_not_accepted"
  | "no_include_rule_matches"
  | "excluded_by_rule";

export interface MatchedRule {
  id: string;
  mode: CoverageMode;
  kind: CoverageKind;
  label: string;
}

export interface ClientVerdict {
  clientId: string;
  name: string;
  status: ClientStatus;
  eligible: boolean;
  /** Every reason the client is not eligible (empty when eligible). */
  reasons: NotEligibleReason[];
  /** The coverage rules that matched this postcode. */
  matchedRules: MatchedRule[];
}

export type CoverageExplanation =
  | { status: "unknown_postcode" }
  | { status: "ok"; postcode: string; outward: string; hasCoordinates: boolean; clients: ClientVerdict[] };

/**
 * The tester: a verdict for EVERY client of the vertical (optionally just one), with all the reasons it fails and the rules that
 * matched. Verdicts are derived from the same matching CTE as findEligibleClients; a test asserts the two agree.
 */
export async function explainCoverage(db: Database, query: CoverageQuery, options: { clientId?: string } = {}): Promise<CoverageExplanation> {
  const geo = await db.selectFrom("postcodes").select(["postcode", "outward", "lat"]).where("postcode", "=", query.postcode).executeTakeFirst();
  if (!geo) return { status: "unknown_postcode" };

  const { rows: clients } = await sql<{ id: string; name: string; status: ClientStatus; accepts_exclusive: boolean; accepts_shared: boolean; offers_service: boolean }>`
    SELECT c.id, c.name, c.status, c.accepts_exclusive, c.accepts_shared,
           EXISTS (SELECT 1 FROM client_services cs WHERE cs.client_id = c.id AND cs.service_type_id = ${query.serviceTypeId}) AS offers_service
      FROM clients c
     WHERE c.vertical_id = ${query.verticalId} AND c.deleted_at IS NULL
       ${options.clientId ? sql`AND c.id = ${options.clientId}` : sql``}
     ORDER BY c.name, c.id`.execute(db);

  const { rows: matched } = await sql<{
    client_id: string; mode: CoverageMode; rule_id: string; kind: CoverageKind; outward: string | null; sector: string | null;
    postcode_prefix: string | null; center_postcode: string | null; radius_m: number | null; area_name: string | null;
  }>`
    WITH ${matchingRulesCte(query.postcode)}
    SELECT r.client_id, r.mode, r.rule_id, a.kind, a.outward, a.sector, a.postcode_prefix, a.center_postcode, a.radius_m, sa.name AS area_name
      FROM matching_rules r
      JOIN client_service_areas a ON a.id = r.rule_id
      LEFT JOIN service_areas sa ON sa.id = a.service_area_id
     ORDER BY a.mode, a.kind`.execute(db); // enum order: include before exclude

  const rulesByClient = new Map<string, MatchedRule[]>();
  for (const row of matched) {
    const list = rulesByClient.get(row.client_id) ?? [];
    list.push({ id: row.rule_id, mode: row.mode, kind: row.kind, label: describeRule(row, row.area_name) });
    rulesByClient.set(row.client_id, list);
  }

  const verdicts = clients.map((client): ClientVerdict => {
    const rules = rulesByClient.get(client.id) ?? [];
    const reasons: NotEligibleReason[] = [];
    if (client.status !== "active") reasons.push("client_not_active");
    if (!client.offers_service) reasons.push("service_not_offered");
    if (!(query.saleType === "exclusive" ? client.accepts_exclusive : client.accepts_shared)) reasons.push("sale_type_not_accepted");
    if (!rules.some((rule) => rule.mode === "include")) reasons.push("no_include_rule_matches");
    if (rules.some((rule) => rule.mode === "exclude")) reasons.push("excluded_by_rule");
    return { clientId: client.id, name: client.name, status: client.status, eligible: reasons.length === 0, reasons, matchedRules: rules };
  });
  return { status: "ok", postcode: geo.postcode, outward: geo.outward, hasCoordinates: geo.lat !== null, clients: verdicts };
}
