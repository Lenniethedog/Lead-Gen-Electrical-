import { randomBytes } from "node:crypto";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret } from "../../src/lib/secrets";
import { createClientService } from "../../src/modules/clients";
import { createTestDatabase, type TestDatabase } from "../helpers/db";
import { buildStage3 } from "../helpers/stage3";

/** How a business wants to be told (stage 5): settings, audit, and the webhook signing secret that is shown once and stored encrypted. */
let t: TestDatabase;
let s: ReturnType<typeof buildStage3>;
let ops: Awaited<ReturnType<ReturnType<typeof buildStage3>["operator"]>>;
const key = randomBytes(32);
let clients: ReturnType<typeof createClientService>;

beforeAll(async () => {
  t = await createTestDatabase();
  s = buildStage3(t);
  ops = await s.operator("delivery-settings@example.com");
  clients = createClientService({ db: t.db, logger: pino({ level: "silent" }), verticalSlug: "roofing", secretsKey: key });
});
afterAll(async () => {
  await t.destroy();
});

const audit = (clientId: string, action: string) => t.admin.selectFrom("audit_logs").selectAll().where("entity_id", "=", clientId).where("action", "=", action).orderBy("id").execute();
const manual = { mode: "manual" as const, email: false, sms: false, webhook: false, webhookUrl: null };

describe("delivery settings", () => {
  it("start manual; switching to automatic records when, once, and every change is audited with before and after", async () => {
    const id = await s.activeClient(ops);
    expect((await clients.deliverySettings(id))).toMatchObject({ mode: "manual", enabledAt: null, email: true, sms: false, webhook: false, webhookUrl: null, secretHint: null });
    expect(await clients.setDeliverySettings({ operator: ops, clientId: id, settings: { mode: "automatic", email: true, sms: true, webhook: false, webhookUrl: null }, requestId: s.rid() })).toEqual({ ok: true });
    const first = (await clients.deliverySettings(id))!;
    expect(first).toMatchObject({ mode: "automatic", email: true, sms: true });
    expect(first.enabledAt).not.toBeNull();

    await clients.setDeliverySettings({ operator: ops, clientId: id, settings: { mode: "automatic", email: true, sms: false, webhook: false, webhookUrl: null }, requestId: s.rid() });
    expect((await clients.deliverySettings(id))!.enabledAt).toEqual(first.enabledAt); // editing a channel does not move the start (it would hide earlier assignments from the health check)
    await clients.setDeliverySettings({ operator: ops, clientId: id, settings: manual, requestId: s.rid() });
    await clients.setDeliverySettings({ operator: ops, clientId: id, settings: { mode: "automatic", email: true, sms: false, webhook: false, webhookUrl: null }, requestId: s.rid() });
    expect((await clients.deliverySettings(id))!.enabledAt!.getTime()).toBeGreaterThan(first.enabledAt!.getTime()); // switching back ON starts afresh

    const entries = await audit(id, "client.delivery_changed");
    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ actor_id: ops.id, before: { mode: "manual", notify_email: true, notify_sms: false }, after: { mode: "automatic", notify_email: true, notify_sms: true } });
  });

  it("an unknown client is not found", async () => {
    expect(await clients.setDeliverySettings({ operator: ops, clientId: "00000000-0000-4000-8000-000000000000", settings: manual, requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
    expect(await clients.deliverySettings("00000000-0000-4000-8000-000000000000")).toBeUndefined();
  });

  it("the database refuses a webhook address that is not https", async () => {
    const id = await s.activeClient(ops);
    await expect(t.admin.updateTable("clients").set({ webhook_url: "http://insecure.example.com/hook" }).where("id", "=", id).execute()).rejects.toThrow(/webhook_url_chk/);
  });
});

describe("the webhook signing secret", () => {
  it("is generated, returned ONCE, stored encrypted, and only its last four characters are ever readable", async () => {
    const id = await s.activeClient(ops);
    const rotated = await clients.rotateWebhookSecret({ operator: ops, clientId: id, requestId: s.rid() });
    if (!rotated.ok) throw new Error(rotated.code);
    expect(rotated.secret).toMatch(/^whsec_/);

    const stored = await t.admin.selectFrom("clients").select(["webhook_secret_enc", "webhook_secret_hint"]).where("id", "=", id).executeTakeFirstOrThrow();
    expect(stored.webhook_secret_enc).not.toContain(rotated.secret.slice(8));
    expect(decryptSecret(key, stored.webhook_secret_enc!)).toBe(rotated.secret);
    expect(stored.webhook_secret_hint).toBe(rotated.secret.slice(-4));
    const read = JSON.stringify(await clients.deliverySettings(id));
    expect(read).not.toContain(rotated.secret);
    expect(read).not.toContain(stored.webhook_secret_enc!);
    expect((await clients.deliverySettings(id))!.secretHint).toBe(rotated.secret.slice(-4));

    const second = await clients.rotateWebhookSecret({ operator: ops, clientId: id, requestId: s.rid() });
    if (!second.ok) throw new Error(second.code);
    expect(second.secret).not.toBe(rotated.secret);
    const dump = JSON.stringify(await audit(id, "client.webhook_secret_rotated"));
    expect(dump).not.toContain(rotated.secret);
    expect(dump).not.toContain(second.secret);
    expect((await audit(id, "client.webhook_secret_rotated"))).toHaveLength(2);
  });

  it("cannot be generated without the encryption key, and a webhook can then be switched on", async () => {
    const id = await s.activeClient(ops);
    const bare = createClientService({ db: t.db, logger: pino({ level: "silent" }), verticalSlug: "roofing" });
    expect(await bare.rotateWebhookSecret({ operator: ops, clientId: id, requestId: s.rid() })).toEqual({ ok: false, code: "secrets_unavailable" });
    await clients.rotateWebhookSecret({ operator: ops, clientId: id, requestId: s.rid() });
    expect(await clients.setDeliverySettings({ operator: ops, clientId: id, settings: { mode: "automatic", email: false, sms: false, webhook: true, webhookUrl: "https://crm.example.com/h" }, requestId: s.rid() })).toEqual({ ok: true });
    expect(await clients.rotateWebhookSecret({ operator: ops, clientId: "00000000-0000-4000-8000-000000000000", requestId: s.rid() })).toEqual({ ok: false, code: "not_found" });
  });
});
