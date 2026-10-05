import type { Database } from "@/lib/db/client";
import { normalisePostcode } from "@/modules/postcodes/normalise";
import { explainCoverage, type CoverageExplanation, type SaleType } from "./repo";

export interface CoverageServiceDeps {
  db: Database;
  verticalSlug: string;
}

export interface CoverageTesterData {
  services: Array<{ slug: string; label: string }>;
  /** Undefined until the operator has asked a question. */
  result?:
    | { kind: "invalid_postcode" }
    | { kind: "unknown_service" }
    | { kind: "explained"; explanation: CoverageExplanation; serviceLabel: string; saleType: SaleType };
}

/** The coverage tester: "which clients would receive a lead here?", via the SAME query routing uses, with a reason for every verdict. */
export function createCoverageService({ db, verticalSlug }: CoverageServiceDeps) {
  return {
    async tester(params: { postcode?: string | undefined; service?: string | undefined; sale?: string | undefined }): Promise<CoverageTesterData> {
      const vertical = await db.selectFrom("verticals").select("id").where("slug", "=", verticalSlug).executeTakeFirstOrThrow();
      const services = await db.selectFrom("service_types").select(["id", "slug", "label"]).where("vertical_id", "=", vertical.id).where("active", "=", true).orderBy("sort_order").execute();
      const listed = services.map(({ slug, label }) => ({ slug, label }));
      if (!params.postcode?.trim()) return { services: listed };

      const postcode = normalisePostcode(params.postcode);
      if (!postcode) return { services: listed, result: { kind: "invalid_postcode" } };
      const service = services.find((candidate) => candidate.slug === params.service) ?? services[0];
      if (!service) return { services: listed, result: { kind: "unknown_service" } };
      const saleType: SaleType = params.sale === "shared" ? "shared" : "exclusive";
      const explanation = await explainCoverage(db, { postcode, verticalId: vertical.id, serviceTypeId: service.id, saleType });
      return { services: listed, result: { kind: "explained", explanation, serviceLabel: service.label, saleType } };
    },
  };
}

export type CoverageService = ReturnType<typeof createCoverageService>;
