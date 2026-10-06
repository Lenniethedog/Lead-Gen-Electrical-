import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import pino from "pino";
import { createClientService } from "../../src/modules/clients";
import { createDeliveryService, type DeliveryService, type SendResult } from "../../src/modules/delivery";
import type { Operator } from "../../src/modules/inbox";
import { createRoutingService, type RoutingService } from "../../src/modules/routing";
import { ScriptedSender } from "./alerts";
import { createTestDatabase, type TestDatabase } from "./db";
import { insertRawLead } from "./raw";
import { buildStage3 } from "./stage3";

type Step<M> = SendResult | "throw" | ((message: M, signal: AbortSignal) => Promise<SendResult>);

/** A scriptable SMS or webhook provider: records every call; after the script runs out every send is accepted (with a message id). */
export class ScriptedChannel<M> {
  calls: M[] = [];
  private script: Array<Step<M>> = [];
  queue(...steps: Array<Step<M>>): this {
    this.script.push(...steps);
    return this;
  }
  async send(message: M, { signal }: { signal: AbortSignal }): Promise<SendResult> {
    this.calls.push(message);
    const step = this.script.shift();
    if (step === "throw") throw new Error("provider exploded");
    if (typeof step === "function") return step(message, signal);
    return step ?? { outcome: "accepted", providerMessageId: `SM${String(this.calls.length).padStart(32, "0")}` };
  }
}

export const retryable = (errorCode = "http_503"): SendResult => ({ outcome: "retryable_failure", errorCode, httpStatus: 503 });
export const permanent = (errorCode = "twilio_21211"): SendResult => ({ outcome: "permanent_failure", errorCode, httpStatus: 400 });

/** The stage 5 delivery service wired as production wires it, over one private test database, with scriptable providers. */
export async function buildDelivery() {
  const t = await createTestDatabase();
  const s = buildStage3(t);
  const owner = await s.operator("owner@delivery.test", "owner");
  const staff = await s.operator("staff@delivery.test", "staff");
  await s.setPrice(owner);

  const secretsKey = randomBytes(32);
  const logger = pino({ level: "silent" });
  const clients = createClientService({ db: t.db, logger, verticalSlug: "electrical", secretsKey });
  const email = new ScriptedSender();
  const sms = new ScriptedChannel<{ to: string; body: string; notificationId: string }>();
  const webhook = new ScriptedChannel<{ url: string; secret: string; body: string; deliveryId: string; event: string }>();

  const make = (db = t.db): DeliveryService =>
    createDeliveryService({ db, logger, senders: { email, sms, webhook }, config: { brandName: "Test Brand", leaseSeconds: 60, sendTimeoutMs: 2_000, batchSize: 5, secretsKey }, random: () => 0.5 });
  const delivery = make();
  const routing: RoutingService = createRoutingService({ db: t.db, logger, verticalSlug: "electrical", isSuppressed: s.privacy.isSuppressed });

  async function automaticClient(by: Operator, options: { email?: boolean; sms?: boolean; webhook?: boolean; name?: string; outward?: string[]; phone?: boolean } = {}): Promise<string> {
    const id = await s.activeClient(by, { name: options.name, outward: options.outward });
    if (options.phone === false) await t.admin.updateTable("clients").set({ contact_phone_e164: null }).where("id", "=", id).execute();
    if (options.webhook) {
      const rotated = await clients.rotateWebhookSecret({ operator: by, clientId: id, requestId: s.rid() });
      if (!rotated.ok) throw new Error(`rotate: ${rotated.code}`);
    }
    const result = await clients.setDeliverySettings({
      operator: by,
      clientId: id,
      settings: { mode: "automatic", email: options.email ?? true, sms: options.sms ?? false, webhook: options.webhook ?? false, webhookUrl: options.webhook ? "https://crm.example.com/hook" : null },
      requestId: s.rid(),
    });
    if (!result.ok) throw new Error(`setDeliverySettings: ${result.code}`);
    return id;
  }

  /** A new lead handed to a business by an operator (the trigger enqueues the notifications). */
  async function assign(clientId: string, by: Operator = staff, lead?: { id: string }): Promise<{ leadId: string; assignmentId: string }> {
    const l = lead ?? (await insertRawLead(t.admin, { email: `p${randomBytes(4).toString("hex")}@example.com`, phone: `+4479${Math.floor(10_000_000 + Math.random() * 89_999_999)}` }));
    const result = await s.assignments.assign({ operator: by, leadId: l.id, clientId, requestId: s.rid() });
    if (!result.ok) throw new Error(`assign: ${result.code}`);
    return { leadId: l.id, assignmentId: result.assignmentId };
  }

  const drain = async (service: DeliveryService = delivery) => {
    const total = { claimed: 0, sent: 0, retrying: 0, failed: 0, cancelled: 0 };
    for (let i = 0; i < 100; i++) {
      const summary = await service.processDue();
      if (summary.claimed === 0) break;
      for (const key of Object.keys(total) as Array<keyof typeof total>) total[key] += summary[key];
    }
    return total;
  };

  const notifications = (assignmentId: string) => t.admin.selectFrom("notifications").selectAll().where("assignment_id", "=", assignmentId).orderBy("channel").execute();
  const attempts = (notificationId: string) => t.admin.selectFrom("notification_attempts").selectAll().where("notification_id", "=", notificationId).orderBy("attempt_no").execute();
  const assignmentRow = (id: string) => t.admin.selectFrom("lead_assignments").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
  const leadStatus = async (id: string) => (await t.admin.selectFrom("leads").select("status").where("id", "=", id).executeTakeFirstOrThrow()).status;
  const makeDue = (notificationId: string) => sql`update notifications set next_attempt_at = now() - interval '1 second' where id = ${notificationId}`.execute(t.admin);

  return { t, s, owner, staff, clients, email, sms, webhook, delivery, make, routing, secretsKey, automaticClient, assign, drain, notifications, attempts, assignmentRow, leadStatus, makeDue, destroy: () => t.destroy() };
}
export type DeliveryEnv = Awaited<ReturnType<typeof buildDelivery>>;
export type { TestDatabase };
