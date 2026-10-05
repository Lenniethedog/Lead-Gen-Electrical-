import "./_env";
import { randomUUID } from "node:crypto";
import { EnvError, getWorkerEnv } from "../src/lib/env";
import { createEmailSender } from "../src/integrations/email";

// Sends ONE test email through the exact adapter, credentials and recipients the worker uses, and says what the
// provider answered. Use it to prove the email setup before a real lead depends on it:
//
//   npm run ops:email-smoke            (with the worker's environment variables set, e.g. on the worker service)
//
// Exit 0 = the provider accepted it (then check the inbox: arrival, sender name, not in spam). Anything else prints
// the error code and exits 1. Contains no personal data; the subject says it is a test.
async function main() {
  let env;
  try {
    env = getWorkerEnv();
  } catch (error) {
    console.error(error instanceof EnvError ? error.message : error);
    process.exit(1);
  }
  const recipients = env.OPERATOR_ALERT_EMAILS;
  if (recipients.length === 0) {
    console.error("OPERATOR_ALERT_EMAILS is empty: there is nobody to send the test to.");
    process.exit(1);
  }

  const sender = createEmailSender(env);
  const result = await sender.send(
    {
      to: recipients,
      subject: `[${env.BRAND_NAME}] Test alert: email setup check`,
      text: "This is a test sent by `npm run ops:email-smoke`. If you can read it, operator alert emails reach you.\n\nNo lead is involved.\n",
      idempotencyKey: `smoke-${randomUUID()}`,
    },
    { signal: AbortSignal.timeout(10_000) },
  );

  if (result.outcome === "accepted") {
    console.log(`accepted by the provider (provider=${env.EMAIL_PROVIDER}, id=${result.providerMessageId ?? "none"}) -> ${recipients.length} recipient(s). Now check the inbox, including spam.`);
    return;
  }
  console.error(`NOT sent: ${result.outcome} errorCode=${result.errorCode}${result.httpStatus ? ` http=${result.httpStatus}` : ""}`);
  process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
