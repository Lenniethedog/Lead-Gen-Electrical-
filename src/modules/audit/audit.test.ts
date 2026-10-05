import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/client";
import { AuditPrivacyError, writeAudit } from "./repo";

/** A database that records the inserted row, so the privacy guard can be tested without PostgreSQL. */
function recorder() {
  const rows: unknown[] = [];
  const db = {
    insertInto: () => ({ values: (row: unknown) => ({ execute: async () => void rows.push(row) }) }),
  } as unknown as Database;
  return { db, rows };
}
const entry = { actorId: "11111111-1111-1111-1111-111111111111", action: "client.updated", entityType: "client", entityId: "x" };

describe("writeAudit", () => {
  it("records business facts, serialising before and after", async () => {
    const { db, rows } = recorder();
    await writeAudit(db, { ...entry, before: { status: "prospect" }, after: { status: "active", contact_email: "roofer@example.com" }, reason: "onboarded", requestId: "req-1" });
    expect(rows[0]).toMatchObject({ actor_type: "staff_user", action: "client.updated", before: '{"status":"prospect"}', reason: "onboarded", request_id: "req-1" });
  });

  it.each(["phone", "phone_e164", "email", "email_normalised", "full_name", "postcode", "ip", "user_agent"])(
    "refuses an entry containing the consumer field %s, at any depth",
    async (field) => {
      const { db, rows } = recorder();
      await expect(writeAudit(db, { ...entry, after: { lead: { nested: [{ [field]: "x" }] } } })).rejects.toBeInstanceOf(AuditPrivacyError);
      await expect(writeAudit(db, { ...entry, before: { [field.toUpperCase()]: "x" } })).rejects.toBeInstanceOf(AuditPrivacyError);
      expect(rows).toHaveLength(0);
    },
  );

  it("allows a client's own business contact fields (they are not consumer data)", async () => {
    const { db, rows } = recorder();
    await writeAudit(db, { ...entry, after: { contact_email: "roofer@example.com", contact_phone_e164: "+441234567890", contact_name: "Dave" } });
    expect(rows).toHaveLength(1);
  });
});
