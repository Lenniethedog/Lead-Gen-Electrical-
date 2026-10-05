import type { Instrumentation } from "next";

// Runs once when the server process starts, before it accepts traffic. A deployment with broken
// configuration must refuse to start (and fail its health check) rather than limp along and
// return 500s to customers.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getServerEnv } = await import("@/lib/env");
    const env = getServerEnv();
    // No-op unless SENTRY_DSN is set (required in production). Scrubbed: see src/lib/error-reporting.ts.
    const { initErrorReporting } = await import("@/lib/error-reporting");
    await initErrorReporting({
      dsn: env.SENTRY_DSN,
      environment: env.APP_ENV,
      service: "leadgen-web",
      release: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.SOURCE_VERSION,
    });
  }
}

/**
 * Every unhandled server error (render, route handler, server action, proxy) reaches the error
 * reporter. Only the route PATTERN and the kind of failure are sent: never the URL, query string,
 * headers or body, which can carry personal data.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getErrorReporter } = await import("@/lib/error-reporting");
  const reporter = getErrorReporter();
  if (!reporter.enabled) return;
  reporter.captureException(error, {
    tags: { routePath: context.routePath, routeType: context.routeType, method: request.method },
  });
  await reporter.flush(1_500);
};
