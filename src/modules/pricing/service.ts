import type { Logger } from "pino";
import type { Database } from "@/lib/db/client";
import { writeAudit } from "@/modules/audit";
import type { Operator } from "@/modules/inbox";
import { endRule, endRulesWithScope, insertRule, listRules, lockPricingScope, pricingMoment, resolvePrice, type LeadPricingFacts, type PricingRuleRow, type ResolvedPrice } from "./repo";
import type { PricingRuleInput } from "./schemas";

export interface PricingServiceDeps {
  db: Database;
  logger: Logger;
  verticalSlug: string;
}

export type PricingFailure = "unknown_service" | "unknown_area" | "not_found";
export type PricingResult<T = object> = ({ ok: true } & T) | { ok: false; code: PricingFailure };

export function createPricingService({ db, logger, verticalSlug }: PricingServiceDeps) {
  async function verticalId(): Promise<number> {
    const row = await db.selectFrom("verticals").select("id").where("slug", "=", verticalSlug).executeTakeFirstOrThrow();
    return row.id;
  }

  return {
    async list(): Promise<{ rules: PricingRuleRow[]; services: Array<{ slug: string; label: string }>; areas: Array<{ slug: string; name: string }> }> {
      const vertical = await verticalId();
      const [rules, services, areas] = await Promise.all([
        listRules(db, vertical),
        db.selectFrom("service_types").select(["slug", "label"]).where("vertical_id", "=", vertical).where("active", "=", true).orderBy("sort_order").execute(),
        db.selectFrom("service_areas").select(["slug", "name"]).where("active", "=", true).orderBy("name").execute(),
      ]);
      return { rules, services, areas };
    },

    resolve(facts: LeadPricingFacts, at?: Date): Promise<ResolvedPrice | undefined> {
      return resolvePrice(db, facts, at);
    },

    /**
     * Sets the price for a scope: ends the current rule with exactly that scope (if any) and creates the new one in ONE transaction,
     * so there is never a moment with two current rules for the same scope, and the history shows what changed and who changed it.
     */
    async setPrice(input: { operator: Operator; rule: PricingRuleInput; requestId: string }): Promise<PricingResult<{ id: string }>> {
      const vertical = await verticalId();
      let serviceTypeId: number | null = null;
      if (input.rule.serviceSlug) {
        const service = await db.selectFrom("service_types").select("id").where("vertical_id", "=", vertical).where("slug", "=", input.rule.serviceSlug).executeTakeFirst();
        if (!service) return { ok: false, code: "unknown_service" };
        serviceTypeId = service.id;
      }
      let serviceAreaId: number | null = null;
      if (input.rule.serviceAreaSlug) {
        const area = await db.selectFrom("service_areas").select("id").where("slug", "=", input.rule.serviceAreaSlug).executeTakeFirst();
        if (!area) return { ok: false, code: "unknown_area" };
        serviceAreaId = area.id;
      }

      const scope = { verticalId: vertical, serviceTypeId, serviceAreaId, urgency: input.rule.urgency, saleType: input.rule.saleType };
      const id = await db.transaction().execute(async (trx) => {
        await lockPricingScope(trx, scope);
        const at = await pricingMoment(trx);
        const replaced = await endRulesWithScope(trx, scope, at);
        const created = await insertRule(trx, { ...scope, pricePence: input.rule.pricePence, createdBy: input.operator.id }, at);
        await writeAudit(trx, {
          actorId: input.operator.id,
          action: "pricing.rule_created",
          entityType: "pricing_rule",
          entityId: created,
          before: replaced.length > 0 ? { ended_rules: replaced.map((rule) => ({ id: rule.id, price_pence: rule.pricePence })) } : undefined,
          after: { service: input.rule.serviceSlug, area: input.rule.serviceAreaSlug, urgency: input.rule.urgency, sale_type: input.rule.saleType, price_pence: input.rule.pricePence },
          requestId: input.requestId,
        });
        return created;
      });
      logger.info({ pricingRuleId: id, operatorId: input.operator.id }, "pricing rule created");
      return { ok: true, id };
    },

    async end(input: { operator: Operator; ruleId: string; requestId: string }): Promise<PricingResult> {
      return db.transaction().execute(async (trx): Promise<PricingResult> => {
        const ended = await endRule(trx, input.ruleId);
        if (!ended) return { ok: false, code: "not_found" };
        await writeAudit(trx, { actorId: input.operator.id, action: "pricing.rule_ended", entityType: "pricing_rule", entityId: ended.id, before: { price_pence: ended.pricePence }, requestId: input.requestId });
        return { ok: true };
      });
    },
  };
}

export type PricingService = ReturnType<typeof createPricingService>;
