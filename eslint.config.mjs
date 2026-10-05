import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Architecture rules, enforced rather than merely documented (docs/01-architecture.md):
 *
 *   src/app, src/components   web layer   -> may use modules, lib, config
 *   src/server                composition -> may use everything server-side
 *   src/modules               domain      -> must NOT know the web layer exists
 *   src/lib, src/config       foundations -> must not depend on modules or the web layer
 *
 * UI code additionally may not reach for the database, Node built-ins or a module's repository.
 * The operator inbox (src/app/admin) is the one place pages render server data directly, and it may
 * do so ONLY through the data-access layer in src/server/admin (which authenticates every call).
 */
// A module's SQL (repo) and use-case code (service) are private: other code reaches a module through its index.ts. Pure, browser-safe
// helpers (schemas, normalise, phone, reasons) may still be imported by path so the browser bundle stays small.
// Flat config REPLACES a rule's options when a later block sets the same rule, so this pattern is added by `restrict` to every block.
const MODULE_PRIVATE = { group: ["@/modules/*/repo", "@/modules/*/service", "@/modules/*/service/*"], message: "Use the module's index.ts: its repo and service files are private to the module." };
const restrict = (patterns) => ({ "no-restricted-imports": ["error", { patterns: [...patterns, MODULE_PRIVATE] }] });

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.test.{ts,tsx}"],
    rules: restrict([]),
  },
  {
    files: ["src/modules/**/*.{ts,tsx}"],
    rules: restrict([
      { group: ["@/app/*", "@/components/*", "@/server/*", "next/*"], message: "Domain modules must not depend on the web layer or Next.js." },
    ]),
  },
  {
    files: ["src/lib/**/*.{ts,tsx}", "src/config/**/*.{ts,tsx}"],
    rules: restrict([
      { group: ["@/app/*", "@/components/*", "@/server/*"], message: "Foundations must not depend on the web layer." },
    ]),
  },
  {
    files: ["src/components/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: restrict([
      { group: ["@/server/*", "@/lib/db/*", "**/repo", "pg", "kysely"], message: "UI code must not import database or server-only code. Call the API instead." },
      { group: ["node:*"], message: "UI code runs in the browser: no Node built-ins." },
    ]),
  },
  {
    // Overrides the UI rule above for the admin pages: same bans, except the data-access layer is allowed.
    files: ["src/app/admin/**/*.{ts,tsx}"],
    rules: restrict([
      {
        group: ["@/server/container", "@/server/db", "@/server/handlers/*", "@/server/admin/session", "@/server/admin/authorizer"],
        message: "Admin pages may only call the data-access layer in @/server/admin (inbox, clients, pricing, assignments): it authenticates every call.",
      },
      { group: ["@/lib/db/*", "**/repo", "pg", "kysely"], message: "UI code must not import database code. Use the data-access layer." },
      { group: ["node:*"], message: "UI code runs in the browser or is rendered from props: no Node built-ins." },
    ]),
  },
  {
    // The business dashboard (stage 6): same bans as the admin pages, but the data-access layer is src/server/client, which authenticates every call.
    files: ["src/app/dashboard/**/*.{ts,tsx}"],
    rules: restrict([
      {
        group: ["@/server/container", "@/server/db", "@/server/handlers/*", "@/server/admin/*", "@/server/client/*", "!@/server/client/portal", "!@/server/client/signin", "!@/server/client/session"],
        message: "Dashboard pages may only call the data-access layer in @/server/client (portal, signin, session): it authenticates every call.",
      },
      { group: ["@/lib/db/*", "**/repo", "pg", "kysely"], message: "UI code must not import database code. Use the data-access layer." },
      { group: ["node:*"], message: "UI code runs in the browser or is rendered from props: no Node built-ins." },
    ]),
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", ".local/**", "test-results/**", "playwright-report/**"]),
]);

export default eslintConfig;
