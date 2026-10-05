import pino from "pino";
import { createAssignmentService, type AssignmentService } from "../../src/modules/assignments";
import { createClientService, type ClientService, type CoverageRuleInput } from "../../src/modules/clients";
import { ensureOperator, type Operator } from "../../src/modules/inbox";
import { createPricingService, type PricingService } from "../../src/modules/pricing";
import { createPrivacyService, type PrivacyService } from "../../src/modules/privacy";
import type { TestDatabase } from "./db";

export const HASH_KEY = "test-privacy-hash-key-0123456789abcdef-not-secret";

/** The stage 3 services wired exactly as production wires them, over one test database. */
export function buildStage3(t: TestDatabase) {
  const logger = pino({ level: "silent" });
  const clients: ClientService = createClientService({ db: t.db, logger, verticalSlug: "roofing" });
  const pricing: PricingService = createPricingService({ db: t.db, logger, verticalSlug: "roofing" });
  const privacy: PrivacyService = createPrivacyService({ db: t.db, logger, hashKey: HASH_KEY });
  const assignments: AssignmentService = createAssignmentService({ db: t.db, logger, brandName: "Test Brand", isSuppressed: privacy.isSuppressed });
  const rid = () => `req-${crypto.randomUUID().slice(0, 8)}`;

  async function operator(email = `op-${crypto.randomUUID().slice(0, 6)}@example.com`, role: Operator["role"] = "staff"): Promise<Operator> {
    return ensureOperator(t.db, email, role);
  }

  /** An ACTIVE client offering roof repair, covering the given outward codes (default BR6). */
  async function activeClient(by: Operator, options: { name?: string; outward?: string[]; rules?: CoverageRuleInput[]; contactName?: string } = {}): Promise<string> {
    const created = await clients.create({
      operator: by,
      client: {
        name: options.name ?? `Roofer ${crypto.randomUUID().slice(0, 4)}`,
        contactName: options.contactName ?? "Dave",
        contactEmail: `${crypto.randomUUID().slice(0, 8)}@roofer.example`,
        contactPhone: "+447911123456",
        acceptsExclusive: true,
        acceptsShared: false,
        legalName: undefined,
        companyNumber: undefined,
        notes: undefined,
      },
      requestId: rid(),
    });
    await clients.setServices({ operator: by, clientId: created.id, serviceSlugs: ["roof_repair"], requestId: rid() });
    const rules = options.rules ?? (options.outward ?? ["BR6"]).map((outward): CoverageRuleInput => ({ mode: "include", kind: "outward", outward }));
    for (const rule of rules) await clients.addRule({ operator: by, clientId: created.id, rule, requestId: rid() });
    const status = await clients.setStatus({ operator: by, clientId: created.id, status: "active", requestId: rid() });
    if (!status.ok) throw new Error(`could not activate client: ${status.code}`);
    return created.id;
  }

  async function setPrice(by: Operator, pricePence = 3500): Promise<void> {
    const result = await pricing.setPrice({ operator: by, rule: { serviceSlug: null, serviceAreaSlug: null, urgency: null, saleType: "exclusive", pricePence }, requestId: rid() });
    if (!result.ok) throw new Error(result.code);
  }

  return { clients, pricing, privacy, assignments, operator, activeClient, setPrice, rid };
}
