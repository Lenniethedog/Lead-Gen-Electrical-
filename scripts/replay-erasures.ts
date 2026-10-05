import "./_env";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pino from "pino";
import { createDb } from "../src/lib/db/client";
import { createPrivacyService, extractErasedLeadIds } from "../src/modules/privacy";

// After restoring a backup, re-apply the erasures made since it was taken. A backup still contains people who have since been
// erased; the platform's logs (retained independently of the database) record every erasure by lead id.
//
//   npm run ops:replay-erasures -- <logfile> [--apply]
//
// Reads newline-delimited JSON logs from <logfile> ("-" for stdin). Without --apply it only REPORTS what would be erased.
// Needs DATABASE_URL (the application role is enough) and PRIVACY_HASH_KEY (the SAME key the application uses, so the people are
// suppressed under the right hashes). Prints counts and ids only, never personal data. Safe to run repeatedly.
async function main() {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) {
    console.error("usage: replay-erasures <logfile | -> [--apply]");
    process.exit(2);
  }
  const apply = flags.includes("--apply");
  const url = process.env.DATABASE_URL;
  const hashKey = process.env.PRIVACY_HASH_KEY;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (!hashKey || hashKey.length < 32) throw new Error("PRIVACY_HASH_KEY must be set (at least 32 characters): use the application's own key");

  const ids = extractErasedLeadIds(readFileSync(file === "-" ? 0 : file, "utf8"));
  const db = createDb({ url, ssl: process.env.DATABASE_SSL, poolMax: 2, applicationName: "leadgen-replay-erasures" });
  try {
    const privacy = createPrivacyService({ db, logger: pino({ level: "warn" }), hashKey });
    let stillPresent = 0;
    let reapplied = 0;
    let missing = 0;
    for (const leadId of ids) {
      const row = await db.selectFrom("lead_contacts").select("erased_at").where("lead_id", "=", leadId).executeTakeFirst();
      if (!row) {
        missing += 1; // the lead is not in this database (it was created after the backup being restored)
        continue;
      }
      if (row.erased_at !== null) continue; // already erased
      stillPresent += 1;
      if (apply) {
        const result = await privacy.replayErasure({ leadId, requestId: `replay-${randomUUID().slice(0, 8)}` });
        if (result.ok) reapplied += 1;
      }
    }
    console.log(`${ids.length} erasure(s) in the log: ${stillPresent} not yet erased here, ${missing} not in this database, ${ids.length - stillPresent - missing} already erased.`);
    console.log(apply ? `re-applied ${reapplied}.` : stillPresent > 0 ? "DRY RUN: nothing changed. Re-run with --apply to erase them." : "nothing to do.");
  } finally {
    await db.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
