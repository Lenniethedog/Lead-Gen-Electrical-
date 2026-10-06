import "server-only";
import { buildConsent } from "@/config/consent";
import { ELECTRICAL } from "@/config/verticals/electrical";
import { getBrand } from "@/config/brand";
import { getServerEnv } from "@/lib/env";
import { getLogger } from "@/lib/logger";
import { SlidingWindowRateLimiter } from "@/lib/rate-limit";
import { createTurnstileVerifier } from "@/modules/fraud";
import { DEV_PRIVACY_HASH_KEY } from "@/config/privacy";
import { createAssignmentService, type AssignmentService } from "@/modules/assignments";
import { createClientService, type ClientService } from "@/modules/clients";
import { createCoverageService, type CoverageService } from "@/modules/coverage";
import { createBillingService, type BillingService } from "@/modules/billing";
import { createClientAuthService, type ClientAuthService } from "@/modules/clientauth";
import { createDisputeService, type DisputeService } from "@/modules/disputes";
import { createPortalService, type PortalService } from "@/modules/portal";
import { createEmailSender } from "@/integrations/email";
import type { ClientIpConfig } from "@/lib/ip";
import { createInboxService, type InboxService } from "@/modules/inbox";
import { createPricingService, type PricingService } from "@/modules/pricing";
import { createPrivacyService, type PrivacyService } from "@/modules/privacy";
import { createRoutingService, type RoutingService } from "@/modules/routing";
import { createDeliveryService, type DeliveryService } from "@/modules/delivery";
import { parseSecretsKey } from "@/lib/secrets";
import { twilioCallbackUrl } from "@/integrations/delivery";
import type { TwilioCallbackDeps } from "./handlers/twilio-callback";
import { createLeadService } from "@/modules/leads";
import { createPostcodeService } from "@/modules/postcodes";
import { createReferenceDataProvider } from "@/modules/reference";
import { getDb } from "./db";
import type { CheckPostcodeDeps } from "./handlers/check-postcode";
import type { ReadyDeps } from "./handlers/health";
import type { PipelineDeps } from "./handlers/pipeline";
import type { SubmitLeadDeps } from "./handlers/submit-lead";

/**
 * Composition root: the ONE place where concrete implementations are chosen and wired together.
 * Everything else receives its dependencies as parameters, which keeps modules independent of
 * Next.js and trivially testable.
 */
export interface Container {
  submitLead: SubmitLeadDeps;
  checkPostcode: CheckPostcodeDeps;
  ready: ReadyDeps;
  pipeline: PipelineDeps;
  /** The operator inbox (stage 2). Reached only through src/server/admin, which authenticates first. */
  inbox: InboxService;
  /** Stage 3: clients, flat prices, who holds which lead, and the privacy actions. Also reached only through src/server/admin. */
  clients: ClientService;
  coverage: CoverageService;
  pricing: PricingService;
  assignments: AssignmentService;
  privacy: PrivacyService;
  /** Stage 4: automatic routing's settings, rules, runs and the "who would get this lead?" explanation. The router itself runs in the worker. */
  routing: RoutingService;
  /** Stage 5: the delivery outbox as the admin sees it (what went to each business, failures, retry) and provider reports. The sending itself runs in the worker. */
  delivery: DeliveryService;
  twilioCallback: TwilioCallbackDeps;
  /** Stage 6: how a business's people sign in, and what they see once they have. Reached only through src/server/client (and, for staff, src/server/admin). */
  clientAuth: ClientAuthService;
  portal: PortalService;
  /** Stage 6: credit, charges and the proof they add up. Staff reach it through src/server/admin; a business through src/server/client. */
  billing: BillingService;
  /** Stage 6: a business reports a problem with a lead; staff decide (through src/server/admin); the business raises/withdraws (through src/server/client). */
  disputes: DisputeService;
  /** Limits on asking for sign-in links, per client address (in memory; the per-person limit is in the database). */
  signIn: { ipConfig: ClientIpConfig; rateLimiter: SlidingWindowRateLimiter; secureCookies: boolean };
}

const globalForContainer = globalThis as typeof globalThis & { __leadgenContainer?: Container };

function buildContainer(): Container {
  const env = getServerEnv();
  const logger = getLogger();
  const db = getDb();

  const ipConfig = { mode: env.TRUST_PROXY, trustedHops: env.TRUSTED_PROXY_HOPS, originSecret: env.ORIGIN_SHARED_SECRET };
  // On a laptop the dev server may not be on the port APP_URL names (3000 is often taken); any local port is fine there, never in production.
  const localDevelopmentOrigins = process.env.NODE_ENV === "production" ? [] : ["http://localhost:*", "http://127.0.0.1:*"];
  const allowedOrigins = [env.APP_URL, ...env.ALLOWED_ORIGINS, ...localDevelopmentOrigins];

  const reference = createReferenceDataProvider(db);
  const postcodes = createPostcodeService(db);
  // Validation guarantees a real key whenever the app is deployed; the public dev key exists only for laptops and tests.
  const privacy = createPrivacyService({ db, logger, hashKey: env.PRIVACY_HASH_KEY ?? DEV_PRIVACY_HASH_KEY });

  // The web process never sends (the worker does), so its senders refuse: processDue is never called here.
  const notAWorker = { send: async () => ({ outcome: "retryable_failure" as const, errorCode: "not_a_worker" }) };
  const assignments = createAssignmentService({ db, logger, brandName: getBrand().name, isSuppressed: privacy.isSuppressed });
  const delivery = createDeliveryService({
    db, logger, senders: { email: notAWorker },
    config: { brandName: getBrand().name, leaseSeconds: 60, sendTimeoutMs: 8_000, batchSize: 1 },
  });

  return {
    submitLead: {
      leadService: createLeadService({
        db,
        postcodes,
        reference,
        challenge: createTurnstileVerifier({ secret: env.TURNSTILE_SECRET_KEY }),
        logger,
        verticalSlug: ELECTRICAL.slug,
        ownHost: new URL(env.APP_URL).hostname,
      }),
      logger,
      ipConfig,
      allowedOrigins,
      // 8 submissions / 10 min / IP: a busy household or office, not a script.
      rateLimiter: new SlidingWindowRateLimiter({ limit: 8, windowMs: 10 * 60_000 }),
    },
    checkPostcode: {
      postcodes,
      reference,
      verticalSlug: ELECTRICAL.slug,
      logger,
      ipConfig,
      allowedOrigins,
      rateLimiter: new SlidingWindowRateLimiter({ limit: 60, windowMs: 60_000 }),
    },
    ready: { db, consent: buildConsent(getBrand().name), logger },
    pipeline: { db, logger },
    inbox: createInboxService({ db, logger }),
    clients: createClientService({ db, logger, verticalSlug: ELECTRICAL.slug, secretsKey: env.DELIVERY_SECRETS_KEY ? parseSecretsKey(env.DELIVERY_SECRETS_KEY) : undefined }),
    coverage: createCoverageService({ db, verticalSlug: ELECTRICAL.slug }),
    pricing: createPricingService({ db, logger, verticalSlug: ELECTRICAL.slug }),
    privacy,
    assignments,
    routing: createRoutingService({ db, logger, verticalSlug: ELECTRICAL.slug, isSuppressed: privacy.isSuppressed }),
    delivery,
    twilioCallback: { delivery, logger, authToken: env.TWILIO_AUTH_TOKEN, callbackUrl: twilioCallbackUrl(env.APP_URL) },
    clientAuth: createClientAuthService({ db, logger, sender: createEmailSender(env), appUrl: env.APP_URL, brandName: getBrand().name }),
    portal: createPortalService({ db, logger, assignments }),
    billing: createBillingService({ db, logger }),
    disputes: createDisputeService({ db, logger }),
    // 10 requests / 10 min / IP: someone fumbling their address, not someone harvesting accounts.
    signIn: { ipConfig, rateLimiter: new SlidingWindowRateLimiter({ limit: 10, windowMs: 10 * 60_000 }), secureCookies: env.APP_URL.startsWith("https://") },
  };
}

export function getContainer(): Container {
  return (globalForContainer.__leadgenContainer ??= buildContainer());
}
