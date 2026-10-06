import { loadEnvConfig } from "@next/env";
import { defineConfig, devices } from "@playwright/test";

loadEnvConfig(process.cwd());

const PORT = Number(process.env.E2E_PORT ?? 3310);
const BASE_URL = `http://localhost:${PORT}`;
// A stand-in for Cloudflare Access's signing keys, so the admin tests exercise the real token verification.
const JWKS_PORT = Number(process.env.E2E_JWKS_PORT ?? 3399);
// Locally we drive the Chrome that is already installed; in CI run `npx playwright install chromium`.
const channel = process.env.CI ? undefined : "chrome";

/**
 * End-to-end tests run against a PRODUCTION build (`npm run build`) and the development database
 * (`npm run db:local`, migrated and seeded with --dev-postcodes). They create real rows there, using
 * unique contact details per run, and refuse to run against staging/production configuration.
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: { baseURL: BASE_URL, trace: "retain-on-failure" },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], ...(channel && { channel }) } },
    { name: "desktop", use: { ...devices["Desktop Chrome"], ...(channel && { channel }) } },
  ],
  webServer: [
    {
      command: "node tests/e2e/jwks-server.mjs",
      url: `http://127.0.0.1:${JWKS_PORT}/cdn-cgi/access/certs`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { E2E_JWKS_PORT: String(JWKS_PORT) },
    },
    {
      command: `npx next start -p ${PORT}`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        APP_URL: BASE_URL,
        // Operator inbox access, pointed at the stand-in key server (CF_ACCESS_CERTS_URL is refused outside dev/test).
        CF_ACCESS_TEAM_DOMAIN: "e2e.cloudflareaccess.com",
        CF_ACCESS_AUD: "e2e".padEnd(64, "a"),
        ADMIN_ALLOWED_EMAILS: "operator@e2e.example",
        ADMIN_OWNER_EMAILS: "owner@e2e.example",
        CF_ACCESS_CERTS_URL: `http://127.0.0.1:${JWKS_PORT}/cdn-cgi/access/certs`,
        // Encrypts webhook signing secrets (stage 5). A fixed test key: the e2e database holds nothing real.
        DELIVERY_SECRETS_KEY: Buffer.alloc(32, 9).toString("base64"),
      },
    },
  ],
});
