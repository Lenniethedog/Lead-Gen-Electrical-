import * as z from "zod";

/**
 * Typed, validated configuration. Three views exist so each process needs only its own settings:
 *   getSiteEnv()   - values safe to bake into static pages (brand, canonical URL, public site key)
 *   getServerEnv() - everything the web process needs (database, secrets, admin access control)
 *   getWorkerEnv() - everything the worker process needs (database, email provider, alert settings)
 *
 * Validation failures list WHICH variables are wrong, never their values (they may be secrets).
 */

export const APP_ENVIRONMENTS = ["development", "test", "staging", "production"] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

/** Defaults used outside production so the app runs on a fresh checkout. */
const DEV_BRAND = {
  BRAND_NAME: "RoofQuote Local",
  BRAND_LEGAL_NAME: "RoofQuote Local Ltd (placeholder)",
  BRAND_COMPANY_NUMBER: "00000000 (placeholder)",
  BRAND_REGISTERED_ADDRESS: "1 Placeholder Street, Orpington, Kent, BR0 0XX (placeholder)",
  BRAND_ICO_REGISTRATION: "ZA000000 (placeholder)",
  BRAND_PRIVACY_EMAIL: "privacy@example.com",
  BRAND_LAUNCH_REGION: "Orpington, Bromley, Sevenoaks and North Kent",
} as const;

/** Cloudflare's published dummy Turnstile keys (always pass / always fail / forced challenge). */
const TURNSTILE_DUMMY_KEY = /^[123]x0+[A-Z]{2}$/;

const nonEmpty = z.string().trim().min(1);
const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const parseCsv = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

const lowercaseList = (list: string[]) => list.map((item) => item.toLowerCase());
/** A comma-separated list of email addresses, trimmed and lowercased. Empty/unset means an empty list. */
const emailList = z.string().optional().transform(parseCsv).transform(lowercaseList).pipe(z.array(z.email()));
const optionalHttpUrl = z.url().transform(stripTrailingSlash).optional();
/** Cloudflare Access teams always live under cloudflareaccess.com: refusing anything else stops a typo or an attacker-chosen host becoming the key source. */
const ACCESS_TEAM_DOMAIN = /^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/;

const siteShape = {
  APP_ENV: z.enum(APP_ENVIRONMENTS).default("development"),
  APP_URL: z.url().transform(stripTrailingSlash).default("http://localhost:3000"),
  TURNSTILE_SITE_KEY: nonEmpty,
  BRAND_NAME: nonEmpty.default(DEV_BRAND.BRAND_NAME),
  BRAND_LEGAL_NAME: nonEmpty.default(DEV_BRAND.BRAND_LEGAL_NAME),
  BRAND_COMPANY_NUMBER: nonEmpty.default(DEV_BRAND.BRAND_COMPANY_NUMBER),
  BRAND_REGISTERED_ADDRESS: nonEmpty.default(DEV_BRAND.BRAND_REGISTERED_ADDRESS),
  BRAND_ICO_REGISTRATION: nonEmpty.default(DEV_BRAND.BRAND_ICO_REGISTRATION),
  BRAND_PRIVACY_EMAIL: z.email().default(DEV_BRAND.BRAND_PRIVACY_EMAIL),
  BRAND_LAUNCH_REGION: nonEmpty.default(DEV_BRAND.BRAND_LAUNCH_REGION),
  // Explicit sign-off that a qualified person has reviewed the consent wording, privacy notice and
  // terms. Production refuses to start without it; staging/dev show a DRAFT banner instead.
  LEGAL_TEXT_REVIEWED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
};

/** Email sending: the worker sends alerts and deliveries, the web process sends sign-in links to client users (stage 6). */
const emailShape = {
  // console prints the message instead of sending it (development/test only). resend sends for real.
  EMAIL_PROVIDER: z.enum(["console", "resend"]).default("console"),
  RESEND_API_KEY: z.string().min(8).optional(),
  // TESTS ONLY: point the Resend adapter at a local fake. Refused in staging/production.
  RESEND_BASE_URL: z.url().optional(),
  // "Display Name <address@your-domain>" on a domain verified with the provider.
  EMAIL_FROM: z.string().min(3).max(200).optional(),
};

const serverShape = {
  ...siteShape,
  ...emailShape,
  TURNSTILE_SECRET_KEY: nonEmpty,
  ALLOWED_ORIGINS: z.string().optional().transform(parseCsv),
  TRUST_PROXY: z.enum(["none", "cloudflare", "forwarded"]).default("none"),
  // forwarded mode: how many proxies you operate/trust in front of the app (entries are counted
  // from the RIGHT of X-Forwarded-For, which proxies append to; the left side is client-controlled).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(5).default(1),
  // cloudflare mode: a random value Cloudflare injects as the X-Origin-Verify header (Transform
  // Rule). Without it, anyone who finds the origin URL could forge CF-Connecting-IP.
  ORIGIN_SHARED_SECRET: z.string().min(24, "must be at least 24 characters").optional(),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection URL"),
  DATABASE_MIGRATION_URL: z.string().regex(/^postgres(ql)?:\/\//).optional(),
  DATABASE_SSL: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // --- Admin (operator inbox) access control. See docs/04 and src/lib/cf-access.ts. -------------------
  // The inbox is reachable only with a valid Cloudflare Access JWT (verified in the app, not just at the edge)
  // whose email is on the allowlist. Required in staging/production; unset in development means "admin off".
  CF_ACCESS_TEAM_DOMAIN: z.string().toLowerCase().regex(ACCESS_TEAM_DOMAIN, "must look like <team>.cloudflareaccess.com").optional(),
  CF_ACCESS_AUD: z.string().min(16, "must be the Access application's audience tag").optional(),
  ADMIN_ALLOWED_EMAILS: emailList,
  // Owners can do everything staff can, plus the destructive privacy actions (erasing a lead). Implicitly allowed in.
  ADMIN_OWNER_EMAILS: emailList,
  // Secret key for the keyed hashes in `suppressions` (who we must not contact again, without remembering who they are).
  // A plain SHA-256 of a phone number can be reversed by trying every number; with a secret key it cannot. Required in
  // staging/production. NEVER rotate it casually: suppressions made under the old key would stop matching.
  PRIVACY_HASH_KEY: z.string().min(32, "must be at least 32 characters").optional(),
  // Where operators open the inbox (links in alert emails). Defaults to APP_URL.
  ADMIN_BASE_URL: optionalHttpUrl,
  // DEVELOPMENT ONLY: act as this operator without Cloudflare Access. Refused in staging/production.
  ADMIN_DEV_EMAIL: z.email().toLowerCase().optional(),
  // TESTS ONLY: fetch Access signing keys from here instead of the team domain. Refused in staging/production.
  CF_ACCESS_CERTS_URL: z.url().optional(),
  SENTRY_DSN: z.url().optional(),
  // --- Delivery to businesses (stage 5) -----------------------------------------------------------------
  // 32 random bytes, base64 (openssl rand -base64 32). Encrypts each business's webhook signing secret at rest. Needed by the web process
  // (to create and rotate secrets) and the worker (to sign). Without it the webhook channel is unavailable; losing it loses the secrets.
  DELIVERY_SECRETS_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 random bytes, base64 encoded (openssl rand -base64 32)").optional(),
  // Verifies Twilio's delivery reports (POST /api/webhooks/twilio). Without it the endpoint answers 503 and SMS delivery is never confirmed.
  TWILIO_AUTH_TOKEN: z.string().min(16).optional(),
};

const dbShape = {
  DATABASE_URL: serverShape.DATABASE_URL,
  DATABASE_MIGRATION_URL: serverShape.DATABASE_MIGRATION_URL,
  DATABASE_SSL: serverShape.DATABASE_SSL,
  DATABASE_POOL_MAX: serverShape.DATABASE_POOL_MAX,
};

const workerShape = {
  APP_ENV: siteShape.APP_ENV,
  APP_URL: siteShape.APP_URL,
  LOG_LEVEL: serverShape.LOG_LEVEL,
  BRAND_NAME: siteShape.BRAND_NAME,
  ...dbShape,
  ADMIN_BASE_URL: serverShape.ADMIN_BASE_URL,
  SENTRY_DSN: serverShape.SENTRY_DSN,
  ...emailShape,
  OPERATOR_ALERT_EMAILS: emailList,
  // The router (stage 4) checks that a consumer has not asked us to stop contacting them before it hands their lead to a business, and
  // that check compares keyed hashes. It must be the SAME key the web process uses, or a suppression made there would not be seen here.
  PRIVACY_HASH_KEY: serverShape.PRIVACY_HASH_KEY,
  DELIVERY_SECRETS_KEY: serverShape.DELIVERY_SECRETS_KEY,
  // --- Text messages (Twilio). All four or none. Use an API key, not the account auth token. ----------------
  TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-f]{32}$/i, "must look like AC followed by 32 hex characters").optional(),
  TWILIO_API_KEY_SID: z.string().regex(/^SK[0-9a-f]{32}$/i, "must look like SK followed by 32 hex characters").optional(),
  TWILIO_API_KEY_SECRET: z.string().min(16).optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().regex(/^MG[0-9a-f]{32}$/i, "must look like MG followed by 32 hex characters").optional(),
  // TESTS ONLY: point the Twilio adapter at a local fake. Refused in staging/production.
  TWILIO_BASE_URL: z.url().optional(),
  // TESTS ONLY: let webhooks go to plain-http and loopback receivers. Refused in staging/production.
  WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  // One reminder is sent for a lead still unhandled after this long.
  ALERT_REMINDER_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  // Tuning knobs. The defaults are the tested, documented ones; tests shorten them. Leave unset in production.
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(2).max(600).default(60),
  WORKER_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(5_000),
  WORKER_RECONCILE_MS: z.coerce.number().int().min(250).max(300_000).default(15_000),
  WORKER_GRACE_SECONDS: z.coerce.number().int().min(0).max(3_600).default(60),
};

type SiteShape = typeof siteShape;
type SiteValues = { [K in keyof SiteShape]: z.output<SiteShape[K]> };
type ServerValues = { [K in keyof typeof serverShape]: z.output<(typeof serverShape)[K]> };
type WorkerValues = { [K in keyof typeof workerShape]: z.output<(typeof workerShape)[K]> };

/**
 * Cross-field safety rails. They only bite in staging/production, so a developer laptop stays
 * frictionless but a misconfigured deployment refuses to start (or to build the static pages)
 * instead of silently shipping placeholder legal text or a CAPTCHA that always passes.
 */
function applyDeploymentGuards(
  values: SiteValues & { TURNSTILE_SECRET_KEY?: string; TRUST_PROXY?: string; ORIGIN_SHARED_SECRET?: string },
  ctx: z.RefinementCtx,
) {
  const { APP_ENV } = values;

  // Applies in every environment: trusting CF-Connecting-IP without proof is a spoofing hole.
  if (values.TRUST_PROXY === "cloudflare" && !values.ORIGIN_SHARED_SECRET) {
    ctx.addIssue({
      code: "custom",
      path: ["ORIGIN_SHARED_SECRET"],
      message: "is required when TRUST_PROXY=cloudflare",
    });
  }

  if (APP_ENV !== "staging" && APP_ENV !== "production") return;

  if (!values.APP_URL.startsWith("https://")) {
    ctx.addIssue({ code: "custom", path: ["APP_URL"], message: `must be https in ${APP_ENV}` });
  }
  if (TURNSTILE_DUMMY_KEY.test(values.TURNSTILE_SITE_KEY)) {
    ctx.addIssue({
      code: "custom",
      path: ["TURNSTILE_SITE_KEY"],
      message: `Cloudflare test keys are not allowed in ${APP_ENV}`,
    });
  }
  if (values.TURNSTILE_SECRET_KEY !== undefined && TURNSTILE_DUMMY_KEY.test(values.TURNSTILE_SECRET_KEY)) {
    ctx.addIssue({
      code: "custom",
      path: ["TURNSTILE_SECRET_KEY"],
      message: `Cloudflare test keys are not allowed in ${APP_ENV}`,
    });
  }

  if (APP_ENV === "production") {
    if (!values.LEGAL_TEXT_REVIEWED) {
      ctx.addIssue({
        code: "custom",
        path: ["LEGAL_TEXT_REVIEWED"],
        message: "must be \"true\" in production: have the consent wording, privacy notice and terms reviewed first",
      });
    }
    const required = [
      "BRAND_NAME",
      "BRAND_LEGAL_NAME",
      "BRAND_COMPANY_NUMBER",
      "BRAND_REGISTERED_ADDRESS",
      "BRAND_ICO_REGISTRATION",
      "BRAND_PRIVACY_EMAIL",
    ] as const;
    for (const key of required) {
      const value = values[key];
      if (value === DEV_BRAND[key] || /placeholder/i.test(value) || value.endsWith("@example.com")) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "must be set to your real legal/brand details in production (placeholder detected)",
        });
      }
    }
  }
}

export class EnvError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => ` - ${p}`).join("\n")}`);
    this.name = "EnvError";
  }
}

const isDeployed = (appEnv: AppEnvironment) => appEnv === "staging" || appEnv === "production";

function issue(ctx: z.RefinementCtx, path: string, message: string) {
  ctx.addIssue({ code: "custom", path: [path], message });
}

/** A sender that cannot actually send must be a startup error in a deployed process, not a silent "check your email" that never arrives. */
function applyEmailGuards(values: { APP_ENV: AppEnvironment; EMAIL_PROVIDER: "console" | "resend"; RESEND_API_KEY?: string | undefined; EMAIL_FROM?: string | undefined; RESEND_BASE_URL?: string | undefined }, ctx: z.RefinementCtx) {
  if (values.EMAIL_PROVIDER === "resend") {
    if (!values.RESEND_API_KEY) issue(ctx, "RESEND_API_KEY", "is required when EMAIL_PROVIDER=resend");
    if (!values.EMAIL_FROM) issue(ctx, "EMAIL_FROM", "is required when EMAIL_PROVIDER=resend");
  }
  if (!isDeployed(values.APP_ENV)) return;
  if (values.EMAIL_PROVIDER !== "resend") issue(ctx, "EMAIL_PROVIDER", `must be "resend" in ${values.APP_ENV}: the console provider sends nothing`);
  if (values.RESEND_BASE_URL) issue(ctx, "RESEND_BASE_URL", `a test-only override: not allowed in ${values.APP_ENV}`);
}

/**
 * Admin (operator inbox) access control. Deployed environments must have Cloudflare Access configured:
 * an inbox that shows consumers' phone numbers must never be reachable "because nobody set it up".
 */
function applyAdminGuards(values: ServerValues, ctx: z.RefinementCtx) {
  const { APP_ENV } = values;
  if (Boolean(values.CF_ACCESS_TEAM_DOMAIN) !== Boolean(values.CF_ACCESS_AUD)) {
    issue(ctx, values.CF_ACCESS_TEAM_DOMAIN ? "CF_ACCESS_AUD" : "CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together");
  }
  if (values.ADMIN_DEV_EMAIL && APP_ENV !== "development" && APP_ENV !== "test") {
    issue(ctx, "ADMIN_DEV_EMAIL", `a development-only bypass: not allowed in ${APP_ENV}`);
  }
  if (!isDeployed(APP_ENV)) return;

  if (!values.CF_ACCESS_TEAM_DOMAIN) issue(ctx, "CF_ACCESS_TEAM_DOMAIN", `is required in ${APP_ENV} (the admin inbox sits behind Cloudflare Access)`);
  if (!values.CF_ACCESS_AUD) issue(ctx, "CF_ACCESS_AUD", `is required in ${APP_ENV}`);
  if (values.ADMIN_ALLOWED_EMAILS.length === 0) issue(ctx, "ADMIN_ALLOWED_EMAILS", `is required in ${APP_ENV}: list the operators allowed into the inbox`);
  if (values.ADMIN_OWNER_EMAILS.length === 0) issue(ctx, "ADMIN_OWNER_EMAILS", `is required in ${APP_ENV}: someone must be able to action erasure requests`);
  if (!values.PRIVACY_HASH_KEY) issue(ctx, "PRIVACY_HASH_KEY", `is required in ${APP_ENV}: suppressions are hashed with it`);
  if (values.CF_ACCESS_CERTS_URL) issue(ctx, "CF_ACCESS_CERTS_URL", `a test-only override: not allowed in ${APP_ENV}`);
  if (values.ADMIN_BASE_URL && !values.ADMIN_BASE_URL.startsWith("https://")) issue(ctx, "ADMIN_BASE_URL", `must be https in ${APP_ENV}`);
  if (APP_ENV === "production" && !values.SENTRY_DSN) issue(ctx, "SENTRY_DSN", "is required in production: errors must reach a human");
}

/** The worker is where alerts are sent: a deployed worker that cannot actually send must refuse to start. */
function applyWorkerGuards(values: WorkerValues, ctx: z.RefinementCtx) {
  const { APP_ENV } = values;
  const twilio = [values.TWILIO_ACCOUNT_SID, values.TWILIO_API_KEY_SID, values.TWILIO_API_KEY_SECRET, values.TWILIO_MESSAGING_SERVICE_SID];
  if (twilio.some(Boolean) && !twilio.every(Boolean)) {
    for (const [name, value] of [["TWILIO_ACCOUNT_SID", twilio[0]], ["TWILIO_API_KEY_SID", twilio[1]], ["TWILIO_API_KEY_SECRET", twilio[2]], ["TWILIO_MESSAGING_SERVICE_SID", twilio[3]]] as const) {
      if (!value) issue(ctx, name, "is required when any other TWILIO_* setting is given (all four, or none)");
    }
  }
  applyEmailGuards(values, ctx);
  if (!isDeployed(APP_ENV)) return;

  if (!values.PRIVACY_HASH_KEY) issue(ctx, "PRIVACY_HASH_KEY", `is required in ${APP_ENV}: the router checks suppressions with it, and it must be the web process's key`);
  if (values.OPERATOR_ALERT_EMAILS.length === 0) issue(ctx, "OPERATOR_ALERT_EMAILS", `is required in ${APP_ENV}: someone must receive the alerts`);
  if (values.TWILIO_BASE_URL) issue(ctx, "TWILIO_BASE_URL", `a test-only override: not allowed in ${APP_ENV}`);
  if (values.WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS) issue(ctx, "WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS", `a test-only setting: not allowed in ${APP_ENV}`);
  if (!(values.ADMIN_BASE_URL ?? values.APP_URL).startsWith("https://")) issue(ctx, "ADMIN_BASE_URL", `the link in alert emails must be https in ${APP_ENV}`);
  if (APP_ENV === "production" && !values.SENTRY_DSN) issue(ctx, "SENTRY_DSN", "is required in production: errors must reach a human");
}

function cleanSource(source: Record<string, string | undefined>) {
  // `KEY=` in a .env file means "unset", not "empty string".
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value !== ""));
}

type Guard = (values: never, ctx: z.RefinementCtx) => void;

function parseWith<S extends z.ZodRawShape>(shape: S, source: Record<string, string | undefined>, guards: Guard[]) {
  const schema = z.object(shape).superRefine((values, ctx) => {
    for (const guard of guards) (guard as (values: unknown, ctx: z.RefinementCtx) => void)(values, ctx);
  });
  const result = schema.safeParse(cleanSource(source));
  if (!result.success) {
    throw new EnvError(result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`));
  }
  return result.data;
}

export type SiteEnv = z.output<z.ZodObject<SiteShape>>;
export type ServerEnv = z.output<z.ZodObject<typeof serverShape>>;
export type WorkerEnv = z.output<z.ZodObject<typeof workerShape>>;

export function parseSiteEnv(source: Record<string, string | undefined> = process.env): SiteEnv {
  return parseWith(siteShape, source, [applyDeploymentGuards]) as SiteEnv;
}

export function parseServerEnv(source: Record<string, string | undefined> = process.env): ServerEnv {
  return parseWith(serverShape, source, [applyDeploymentGuards, applyAdminGuards, applyEmailGuards]) as ServerEnv;
}

export function parseWorkerEnv(source: Record<string, string | undefined> = process.env): WorkerEnv {
  return parseWith(workerShape, source, [applyWorkerGuards]) as WorkerEnv;
}

let siteEnvCache: SiteEnv | undefined;
let serverEnvCache: ServerEnv | undefined;
let workerEnvCache: WorkerEnv | undefined;

export function getSiteEnv(): SiteEnv {
  return (siteEnvCache ??= parseSiteEnv());
}

export function getServerEnv(): ServerEnv {
  return (serverEnvCache ??= parseServerEnv());
}

export function getWorkerEnv(): WorkerEnv {
  return (workerEnvCache ??= parseWorkerEnv());
}

/** Test helper: forget cached values so a test can change process.env. */
export function resetEnvCache() {
  siteEnvCache = undefined;
  serverEnvCache = undefined;
  workerEnvCache = undefined;
}
