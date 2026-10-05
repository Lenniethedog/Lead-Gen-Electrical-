import "./_env";
import { EnvError, getWorkerEnv } from "../src/lib/env";
import { initErrorReporting } from "../src/lib/error-reporting";

// Sends one test event to Sentry through the same scrubbed reporter the apps use, so you can see it arrive
// (and see what it contains) before relying on error reporting.   npm run ops:sentry-smoke
async function main() {
  let env;
  try {
    env = getWorkerEnv();
  } catch (error) {
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(1);
  }
  if (!env.SENTRY_DSN) {
    console.error("SENTRY_DSN is not set: error reporting is disabled.");
    process.exit(1);
  }
  const reporter = await initErrorReporting({ dsn: env.SENTRY_DSN, environment: env.APP_ENV, service: "smoke-test" });
  reporter.captureException(new Error("Sentry smoke test (npm run ops:sentry-smoke): ignore, this is a deliberate test"), {
    tags: { smoke: "true" },
  });
  const delivered = await reporter.flush(10_000);
  console.log(delivered ? "event sent: look for it in Sentry (tag smoke=true)." : "flush timed out: the event may not have been delivered. Check the DSN and network egress.");
  process.exit(delivered ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
