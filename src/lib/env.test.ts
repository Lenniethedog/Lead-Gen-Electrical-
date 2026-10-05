import { describe, expect, it } from "vitest";
import { EnvError, parseServerEnv, parseSiteEnv, parseWorkerEnv } from "./env";

const SECRET_TURNSTILE = "0x4AAAAAAAsupersecretvalue12345";

const devBase = {
  DATABASE_URL: "postgres://user:s3cretpassword@db.internal:5432/leadgen",
  TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
};

const productionBase = {
  APP_ENV: "production",
  APP_URL: "https://www.example-roofing.co.uk/",
  DATABASE_URL: "postgres://user:s3cretpassword@db.internal:5432/leadgen",
  TURNSTILE_SITE_KEY: "0x4AAAAAAAsitekeyvalue1234",
  TURNSTILE_SECRET_KEY: SECRET_TURNSTILE,
  BRAND_NAME: "Kent Roof Match",
  BRAND_LEGAL_NAME: "Kent Roof Match Ltd",
  BRAND_COMPANY_NUMBER: "12345678",
  BRAND_REGISTERED_ADDRESS: "12 High Street, Orpington, Kent, BR6 0AB",
  BRAND_ICO_REGISTRATION: "ZB123456",
  BRAND_PRIVACY_EMAIL: "privacy@kentroofmatch.co.uk",
  LEGAL_TEXT_REVIEWED: "true",
  CF_ACCESS_TEAM_DOMAIN: "kentroofmatch.cloudflareaccess.com",
  CF_ACCESS_AUD: "a".repeat(64),
  ADMIN_ALLOWED_EMAILS: "Owner@KentRoofMatch.co.uk, ops@kentroofmatch.co.uk",
  ADMIN_OWNER_EMAILS: "Owner@KentRoofMatch.co.uk",
  PRIVACY_HASH_KEY: "k".repeat(40),
  SENTRY_DSN: "https://publickey@o0.ingest.sentry.io/1",
};

function problemsOf(source: Record<string, string>): string {
  try {
    parseServerEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).message;
  }
  throw new Error("expected parseServerEnv to throw");
}

describe("parseServerEnv in development", () => {
  it("applies safe defaults on a fresh checkout", () => {
    const env = parseServerEnv(devBase);
    expect(env.APP_ENV).toBe("development");
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.TRUST_PROXY).toBe("none");
    expect(env.DATABASE_SSL).toBe("disable");
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.ALLOWED_ORIGINS).toEqual([]);
  });

  it("treats KEY= (empty string) as unset", () => {
    const env = parseServerEnv({ ...devBase, APP_URL: "", ALLOWED_ORIGINS: "", DATABASE_POOL_MAX: "" });
    expect(env.APP_URL).toBe("http://localhost:3000");
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it("parses lists and numbers", () => {
    const env = parseServerEnv({
      ...devBase,
      ALLOWED_ORIGINS: " https://a.example , https://b.example ,",
      DATABASE_POOL_MAX: "25",
      TRUST_PROXY: "forwarded",
      TRUSTED_PROXY_HOPS: "2",
    });
    expect(env.ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
    expect(env.DATABASE_POOL_MAX).toBe(25);
    expect(env.TRUSTED_PROXY_HOPS).toBe(2);
  });

  it("rejects out-of-range or malformed values and names the variable", () => {
    expect(problemsOf({ ...devBase, DATABASE_POOL_MAX: "0" })).toContain("DATABASE_POOL_MAX");
    expect(problemsOf({ ...devBase, DATABASE_URL: "mysql://nope" })).toContain("DATABASE_URL");
    expect(problemsOf({ ...devBase, APP_ENV: "prod" })).toContain("APP_ENV");
    expect(problemsOf({ ...devBase, TRUST_PROXY: "yes" })).toContain("TRUST_PROXY");
  });

  it("requires the connection and challenge settings", () => {
    const message = problemsOf({});
    expect(message).toContain("DATABASE_URL");
    expect(message).toContain("TURNSTILE_SECRET_KEY");
  });

  it("strips trailing slashes from the public URL", () => {
    expect(parseServerEnv({ ...devBase, APP_URL: "http://localhost:3000///" }).APP_URL).toBe("http://localhost:3000");
  });

  it("requires an origin secret before cloudflare mode can be used, in every environment", () => {
    expect(problemsOf({ ...devBase, TRUST_PROXY: "cloudflare" })).toContain("ORIGIN_SHARED_SECRET");
    expect(problemsOf({ ...devBase, TRUST_PROXY: "cloudflare", ORIGIN_SHARED_SECRET: "short" })).toContain(
      "at least 24 characters",
    );
    const ok = parseServerEnv({ ...devBase, TRUST_PROXY: "cloudflare", ORIGIN_SHARED_SECRET: "x".repeat(32) });
    expect(ok.TRUST_PROXY).toBe("cloudflare");
  });
});

describe("parseServerEnv deployment guards", () => {
  it("accepts a fully configured production environment", () => {
    const env = parseServerEnv(productionBase);
    expect(env.APP_ENV).toBe("production");
    expect(env.APP_URL).toBe("https://www.example-roofing.co.uk");
  });

  it("refuses placeholder legal/brand details in production", () => {
    const message = problemsOf({ ...productionBase, BRAND_LEGAL_NAME: "RoofQuote Local Ltd (placeholder)" });
    expect(message).toContain("BRAND_LEGAL_NAME");
    expect(message).toContain("placeholder");

    const missing: Record<string, string> = { ...productionBase };
    delete missing.BRAND_ICO_REGISTRATION;
    expect(problemsOf(missing)).toContain("BRAND_ICO_REGISTRATION");

    expect(problemsOf({ ...productionBase, BRAND_PRIVACY_EMAIL: "privacy@example.com" })).toContain(
      "BRAND_PRIVACY_EMAIL",
    );
  });

  it("refuses to start in production until the legal texts are marked as reviewed", () => {
    const message = problemsOf({ ...productionBase, LEGAL_TEXT_REVIEWED: "false" });
    expect(message).toContain("LEGAL_TEXT_REVIEWED");
    const unset: Record<string, string> = { ...productionBase };
    delete unset.LEGAL_TEXT_REVIEWED;
    expect(problemsOf(unset)).toContain("LEGAL_TEXT_REVIEWED");
    expect(parseServerEnv({ ...productionBase, APP_ENV: "staging" }).LEGAL_TEXT_REVIEWED).toBe(true);
    expect(parseServerEnv({ ...devBase }).LEGAL_TEXT_REVIEWED).toBe(false);
  });

  it("refuses Cloudflare's always-pass Turnstile test keys in production and staging", () => {
    for (const APP_ENV of ["production", "staging"]) {
      const message = problemsOf({
        ...productionBase,
        APP_ENV,
        TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
      });
      expect(message).toContain("TURNSTILE_SITE_KEY");
      expect(message).toContain("TURNSTILE_SECRET_KEY");
    }
  });

  it("requires https in production and staging", () => {
    expect(problemsOf({ ...productionBase, APP_URL: "http://www.example-roofing.co.uk" })).toContain("https");
    expect(problemsOf({ ...productionBase, APP_ENV: "staging", APP_URL: "http://staging.example.co.uk" })).toContain("https");
  });

  it("allows placeholders in staging (not public-facing) but still bans test keys there", () => {
    const staging = {
      ...productionBase,
      APP_ENV: "staging",
      BRAND_LEGAL_NAME: "RoofQuote Local Ltd (placeholder)",
    };
    expect(parseServerEnv(staging).APP_ENV).toBe("staging");
  });

  it("never echoes secret values in error messages", () => {
    const message = problemsOf({
      ...productionBase,
      APP_URL: "http://insecure.example.co.uk",
      DATABASE_POOL_MAX: "-1",
    });
    expect(message).not.toContain("s3cretpassword");
    expect(message).not.toContain(SECRET_TURNSTILE);
  });
});

describe("parseSiteEnv", () => {
  it("does not require database or secret settings (static pages build without them)", () => {
    const env = parseSiteEnv({ TURNSTILE_SITE_KEY: "1x00000000000000000000AA" });
    expect(env.BRAND_NAME).toBe("RoofQuote Local");
  });
});

const accessProduction = productionBase;

describe("admin access control settings (web)", () => {
  it("is optional in development, where the admin is simply off", () => {
    const env = parseServerEnv(devBase);
    expect(env.CF_ACCESS_TEAM_DOMAIN).toBeUndefined();
    expect(env.ADMIN_ALLOWED_EMAILS).toEqual([]);
  });

  it("requires Cloudflare Access and an allowlist in production and staging", () => {
    for (const APP_ENV of ["production", "staging"]) {
      const bare: Record<string, string> = { ...productionBase, APP_ENV };
      for (const key of ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "ADMIN_ALLOWED_EMAILS", "ADMIN_OWNER_EMAILS", "PRIVACY_HASH_KEY"]) delete bare[key];
      const message = problemsOf(bare);
      expect(message).toContain("CF_ACCESS_TEAM_DOMAIN");
      expect(message).toContain("CF_ACCESS_AUD");
      expect(message).toContain("ADMIN_ALLOWED_EMAILS");
      expect(message).toContain("ADMIN_OWNER_EMAILS");
      expect(message).toContain("PRIVACY_HASH_KEY");
    }
  });

  it("accepts a complete production configuration and normalises the allowlist", () => {
    const env = parseServerEnv(accessProduction);
    expect(env.ADMIN_ALLOWED_EMAILS).toEqual(["owner@kentroofmatch.co.uk", "ops@kentroofmatch.co.uk"]);
    expect(env.CF_ACCESS_TEAM_DOMAIN).toBe("kentroofmatch.cloudflareaccess.com");
  });

  it("only accepts a cloudflareaccess.com team domain, so a typo cannot redirect where signing keys come from", () => {
    expect(problemsOf({ ...devBase, CF_ACCESS_TEAM_DOMAIN: "evil.example.com", CF_ACCESS_AUD: "a".repeat(64) })).toContain(
      "CF_ACCESS_TEAM_DOMAIN",
    );
    expect(problemsOf({ ...devBase, CF_ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com.evil.io", CF_ACCESS_AUD: "a".repeat(64) })).toContain(
      "CF_ACCESS_TEAM_DOMAIN",
    );
  });

  it("requires the team domain and audience together", () => {
    expect(problemsOf({ ...devBase, CF_ACCESS_TEAM_DOMAIN: "acme.cloudflareaccess.com" })).toContain("CF_ACCESS_AUD");
    expect(problemsOf({ ...devBase, CF_ACCESS_AUD: "a".repeat(64) })).toContain("CF_ACCESS_TEAM_DOMAIN");
  });

  it("requires an owner and a long privacy hash key when deployed, and normalises the owner list", () => {
    expect(parseServerEnv(accessProduction).ADMIN_OWNER_EMAILS).toEqual(["owner@kentroofmatch.co.uk"]);
    expect(problemsOf({ ...accessProduction, PRIVACY_HASH_KEY: "too-short" })).toContain("PRIVACY_HASH_KEY");
    expect(parseServerEnv({ ...devBase }).PRIVACY_HASH_KEY).toBeUndefined(); // development falls back to a dev-only key in code
    expect(problemsOf({ ...accessProduction, PRIVACY_HASH_KEY: "k".repeat(40) + "SECRETSUFFIX" , ADMIN_OWNER_EMAILS: "not-an-email" })).not.toContain("SECRETSUFFIX");
  });

  it("refuses the development bypass and the test key override anywhere that is deployed", () => {
    expect(problemsOf({ ...accessProduction, ADMIN_DEV_EMAIL: "me@example.com" })).toContain("ADMIN_DEV_EMAIL");
    expect(problemsOf({ ...accessProduction, APP_ENV: "staging", ADMIN_DEV_EMAIL: "me@example.com" })).toContain("ADMIN_DEV_EMAIL");
    expect(problemsOf({ ...accessProduction, CF_ACCESS_CERTS_URL: "http://127.0.0.1:9/certs" })).toContain("CF_ACCESS_CERTS_URL");
    expect(parseServerEnv({ ...devBase, ADMIN_DEV_EMAIL: "Me@Example.com" }).ADMIN_DEV_EMAIL).toBe("me@example.com");
  });

  it("requires error reporting in production only", () => {
    const withoutSentry: Record<string, string> = { ...accessProduction };
    delete withoutSentry.SENTRY_DSN;
    expect(problemsOf(withoutSentry)).toContain("SENTRY_DSN");
    expect(parseServerEnv({ ...withoutSentry, APP_ENV: "staging" }).SENTRY_DSN).toBeUndefined();
  });

  it("rejects a malformed allowlist entry without echoing it", () => {
    const message = problemsOf({ ...devBase, ADMIN_ALLOWED_EMAILS: "ok@example.com, not-an-email-secret" });
    expect(message).toContain("ADMIN_ALLOWED_EMAILS");
    expect(message).not.toContain("not-an-email-secret");
  });
});

const workerDev = { DATABASE_URL: devBase.DATABASE_URL };
const workerProduction = {
  APP_ENV: "production",
  APP_URL: "https://www.kentroofmatch.co.uk",
  ADMIN_BASE_URL: "https://admin.kentroofmatch.co.uk/",
  DATABASE_URL: devBase.DATABASE_URL,
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_live_abcdefghijkl",
  EMAIL_FROM: "Kent Roof Match <alerts@mail.kentroofmatch.co.uk>",
  OPERATOR_ALERT_EMAILS: "Owner@KentRoofMatch.co.uk",
  SENTRY_DSN: "https://publickey@o0.ingest.sentry.io/1",
  PRIVACY_HASH_KEY: "test-privacy-hash-key-0123456789abcdef-not-secret",
};

function workerProblems(source: Record<string, string>): string {
  try {
    parseWorkerEnv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(EnvError);
    return (error as EnvError).message;
  }
  throw new Error("expected parseWorkerEnv to throw");
}

describe("parseWorkerEnv", () => {
  it("runs on a fresh checkout without Turnstile or brand settings, printing instead of sending", () => {
    const env = parseWorkerEnv(workerDev);
    expect(env.EMAIL_PROVIDER).toBe("console");
    expect(env.OPERATOR_ALERT_EMAILS).toEqual([]);
    expect(env.ALERT_REMINDER_MINUTES).toBe(15);
    expect(env.WORKER_LEASE_SECONDS).toBe(60);
    expect(env.WORKER_GRACE_SECONDS).toBe(60);
  });

  it("accepts a complete production configuration and normalises recipients and the admin URL", () => {
    const env = parseWorkerEnv(workerProduction);
    expect(env.OPERATOR_ALERT_EMAILS).toEqual(["owner@kentroofmatch.co.uk"]);
    expect(env.ADMIN_BASE_URL).toBe("https://admin.kentroofmatch.co.uk");
  });

  it("will not start in production or staging with the console provider, no recipients, or a test override", () => {
    for (const APP_ENV of ["production", "staging"]) {
      const message = workerProblems({ ...workerProduction, APP_ENV, EMAIL_PROVIDER: "console" });
      expect(message).toContain("EMAIL_PROVIDER");
      const noRecipients: Record<string, string> = { ...workerProduction, APP_ENV };
      delete noRecipients.OPERATOR_ALERT_EMAILS;
      expect(workerProblems(noRecipients)).toContain("OPERATOR_ALERT_EMAILS");
      expect(workerProblems({ ...workerProduction, APP_ENV, RESEND_BASE_URL: "http://127.0.0.1:9" })).toContain("RESEND_BASE_URL");
      // The router compares keyed hashes of consumers' details: without the web process's key it could not see a suppression.
      const noKey: Record<string, string> = { ...workerProduction, APP_ENV };
      delete noKey.PRIVACY_HASH_KEY;
      expect(workerProblems(noKey)).toContain("PRIVACY_HASH_KEY");
      expect(workerProblems({ ...workerProduction, APP_ENV, PRIVACY_HASH_KEY: "too-short" })).toContain("PRIVACY_HASH_KEY");
    }
  });

  it("requires the provider credentials whenever resend is selected", () => {
    const message = workerProblems({ ...workerDev, EMAIL_PROVIDER: "resend" });
    expect(message).toContain("RESEND_API_KEY");
    expect(message).toContain("EMAIL_FROM");
  });

  it("requires an https link target for alert emails when deployed, falling back to APP_URL", () => {
    expect(workerProblems({ ...workerProduction, ADMIN_BASE_URL: "http://admin.kentroofmatch.co.uk" })).toContain("ADMIN_BASE_URL");
    const noAdminBase: Record<string, string> = { ...workerProduction, APP_URL: "https://www.kentroofmatch.co.uk" };
    delete noAdminBase.ADMIN_BASE_URL;
    expect(parseWorkerEnv(noAdminBase).APP_ENV).toBe("production");
  });

  it("bounds the tuning knobs", () => {
    expect(workerProblems({ ...workerDev, WORKER_LEASE_SECONDS: "0" })).toContain("WORKER_LEASE_SECONDS");
    expect(workerProblems({ ...workerDev, ALERT_REMINDER_MINUTES: "0" })).toContain("ALERT_REMINDER_MINUTES");
    expect(parseWorkerEnv({ ...workerDev, WORKER_LEASE_SECONDS: "3", WORKER_POLL_MS: "100" }).WORKER_LEASE_SECONDS).toBe(3);
  });

  it("never echoes secrets in error messages", () => {
    const message = workerProblems({ ...workerProduction, EMAIL_PROVIDER: "console", DATABASE_POOL_MAX: "-1" });
    expect(message).not.toContain("re_live_abcdefghijkl");
    expect(message).not.toContain("s3cretpassword");
  });
});

describe("delivery settings (stage 5)", () => {
  const twilio = { TWILIO_ACCOUNT_SID: `AC${"a".repeat(32)}`, TWILIO_API_KEY_SID: `SK${"b".repeat(32)}`, TWILIO_API_KEY_SECRET: "twilio-key-secret-0123456789", TWILIO_MESSAGING_SERVICE_SID: `MG${"c".repeat(32)}` };
  const key = Buffer.alloc(32, 7).toString("base64");

  it("Twilio is all four settings or none, and each is checked for shape", () => {
    expect(parseWorkerEnv({ ...workerDev, ...twilio }).TWILIO_ACCOUNT_SID).toBe(twilio.TWILIO_ACCOUNT_SID);
    expect(parseWorkerEnv(workerDev).TWILIO_ACCOUNT_SID).toBeUndefined();
    const partial = workerProblems({ ...workerDev, TWILIO_ACCOUNT_SID: twilio.TWILIO_ACCOUNT_SID });
    for (const name of ["TWILIO_API_KEY_SID", "TWILIO_API_KEY_SECRET", "TWILIO_MESSAGING_SERVICE_SID"]) expect(partial).toContain(name);
    expect(workerProblems({ ...workerDev, ...twilio, TWILIO_ACCOUNT_SID: "nope" })).toContain("TWILIO_ACCOUNT_SID");
    expect(workerProblems({ ...workerDev, ...twilio, TWILIO_API_KEY_SID: "AC" + "a".repeat(32) })).toContain("TWILIO_API_KEY_SID");
  });
  it("the delivery encryption key must be 32 bytes of base64, for the worker and the web process", () => {
    expect(parseWorkerEnv({ ...workerDev, DELIVERY_SECRETS_KEY: key }).DELIVERY_SECRETS_KEY).toBe(key);
    for (const bad of ["short", Buffer.alloc(16).toString("base64"), Buffer.alloc(48).toString("base64")]) expect(workerProblems({ ...workerDev, DELIVERY_SECRETS_KEY: bad }), bad).toContain("DELIVERY_SECRETS_KEY");
  });
  it("the test-only overrides are refused in staging and production", () => {
    for (const APP_ENV of ["staging", "production"]) {
      expect(workerProblems({ ...workerProduction, APP_ENV, TWILIO_BASE_URL: "http://127.0.0.1:9" })).toContain("TWILIO_BASE_URL");
      expect(workerProblems({ ...workerProduction, APP_ENV, WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS: "true" })).toContain("WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS");
    }
    expect(parseWorkerEnv({ ...workerDev, WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS: "true", TWILIO_BASE_URL: "http://127.0.0.1:9" }).WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS).toBe(true);
  });
  it("the loopback exemption is off unless asked for", () => expect(parseWorkerEnv(workerDev).WEBHOOK_ALLOW_LOOPBACK_FOR_TESTS).toBe(false));
});
