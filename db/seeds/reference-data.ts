import { sql } from "kysely";
import { buildConsent } from "@/config/consent";
import { SERVICE_SLUGS, SERVICES, ELECTRICAL } from "@/config/verticals/electrical";
import type { Database } from "@/lib/db/client";
import type { LeadSourceKind } from "@/lib/db/schema";
import { SOURCE_SLUGS, type SourceSlug } from "@/modules/attribution";
import { ensureConsentText } from "@/modules/consent";
import { DEFAULT_RULES, RULE_KIND } from "@/modules/routing";
import { DEV_OUT_OF_AREA_POSTCODES, DEV_POSTCODES } from "./dev-postcodes";
import { SERVICE_AREAS } from "./service-areas";

const SOURCE_DETAILS: Record<SourceSlug, { name: string; kind: LeadSourceKind }> = {
  google_ads: { name: "Google Ads", kind: "paid_search" },
  bing_ads: { name: "Microsoft Advertising", kind: "paid_search" },
  meta_ads: { name: "Meta Ads (Facebook and Instagram)", kind: "paid_social" },
  organic_search: { name: "Organic search", kind: "organic" },
  referral: { name: "Referral", kind: "referral" },
  direct: { name: "Direct", kind: "direct" },
  unknown: { name: "Unknown", kind: "unknown" },
};

export interface SeedSummary {
  vertical: string;
  serviceTypes: number;
  leadSources: number;
  serviceAreas: number;
  districts: number;
  consentVersion: string;
  devPostcodes: number;
  routingRules: number;
}

/**
 * Idempotent: safe to run on every deploy. It creates and updates reference data but never
 * re-activates something an operator deactivated, and never deletes anything.
 */
export async function seedReferenceData(
  db: Database,
  options: { brandName: string; includeDevPostcodes: boolean },
): Promise<SeedSummary> {
  return db.transaction().execute(async (trx) => {
    const vertical = await trx
      .insertInto("verticals")
      .values({ slug: ELECTRICAL.slug, name: ELECTRICAL.name, duplicate_window_days: ELECTRICAL.duplicateWindowDays })
      .onConflict((conflict) => conflict.column("slug").doUpdateSet({ name: ELECTRICAL.name }))
      .returning("id")
      .executeTakeFirstOrThrow();

    for (const [index, slug] of SERVICE_SLUGS.entries()) {
      await trx
        .insertInto("service_types")
        .values({ vertical_id: vertical.id, slug, label: SERVICES[slug].label, sort_order: index })
        .onConflict((conflict) =>
          conflict.columns(["vertical_id", "slug"]).doUpdateSet({ label: SERVICES[slug].label, sort_order: index }),
        )
        .execute();
    }

    for (const slug of SOURCE_SLUGS) {
      const details = SOURCE_DETAILS[slug];
      await trx
        .insertInto("lead_sources")
        .values({ slug, name: details.name, kind: details.kind })
        .onConflict((conflict) => conflict.column("slug").doUpdateSet({ name: details.name, kind: details.kind }))
        .execute();
    }

    let districts = 0;
    for (const area of SERVICE_AREAS) {
      const row = await trx
        .insertInto("service_areas")
        .values({ slug: area.slug, name: area.name })
        .onConflict((conflict) => conflict.column("slug").doUpdateSet({ name: area.name }))
        .returning("id")
        .executeTakeFirstOrThrow();

      for (const outward of area.districts) {
        await trx
          .insertInto("service_area_districts")
          .values({ service_area_id: row.id, outward })
          .onConflict((conflict) => conflict.columns(["service_area_id", "outward"]).doNothing())
          .execute();
        districts += 1;
      }

      await trx
        .insertInto("vertical_service_areas")
        .values({ vertical_id: vertical.id, service_area_id: row.id })
        .onConflict((conflict) => conflict.columns(["vertical_id", "service_area_id"]).doNothing())
        .execute();
    }

    const consent = await ensureConsentText(trx, buildConsent(options.brandName));

    // Routing starts OFF with the default rules, and is never reset: what an owner has edited is left alone (`do nothing`).
    await sql`insert into routing_settings (vertical_id) values (${vertical.id}) on conflict (vertical_id) do nothing`.execute(trx);
    for (const rule of DEFAULT_RULES) {
      await sql`
        insert into routing_rules (vertical_id, type, kind, position, config)
        values (${vertical.id}, ${rule.type}, ${RULE_KIND[rule.type]}::routing_rule_kind, ${rule.position}, ${JSON.stringify(rule.config)}::jsonb)
        on conflict (vertical_id, type) do nothing`.execute(trx);
    }

    let devPostcodes = 0;
    if (options.includeDevPostcodes) {
      for (const row of [...DEV_POSTCODES, ...DEV_OUT_OF_AREA_POSTCODES]) {
        await sql`
          insert into postcodes (postcode, lat, lng, source)
          values (${row.postcode}, ${row.lat}, ${row.lng}, 'dev-synthetic')
          on conflict (postcode) do nothing
        `.execute(trx);
        devPostcodes += 1;
      }
    }

    return {
      vertical: ELECTRICAL.slug,
      serviceTypes: SERVICE_SLUGS.length,
      leadSources: SOURCE_SLUGS.length,
      serviceAreas: SERVICE_AREAS.length,
      districts,
      consentVersion: consent.version,
      devPostcodes,
      routingRules: DEFAULT_RULES.length,
    };
  });
}
