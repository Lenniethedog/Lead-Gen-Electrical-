import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.join(root, "src"),
      // `server-only` throws outside React Server Components; tests are plain Node.
      "server-only": path.join(root, "tests/helpers/server-only.ts"),
    },
  },
  test: {
    env: { APP_ENV: "test", LOG_LEVEL: "silent" },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.test.tsx"],
          setupFiles: ["tests/setup/dom.ts"],
        },
      },
      {
        // Needs a real PostgreSQL (TEST_DATABASE_URL). Each test FILE gets its own database cloned
        // from a freshly migrated + seeded template, so files run in parallel without interference.
        extends: true,
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/setup/postgres.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
