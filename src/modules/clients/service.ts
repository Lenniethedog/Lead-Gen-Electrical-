import type { Logger } from "pino";
import type { Database } from "@/lib/db/client";
import { writeAudit } from "@/modules/audit";
import type { Operator } from "@/modules/inbox";
import {
  countIncludeRules,
  countServices,
  deleteRule,
  getClientDetail,
  getVerticalId,
  insertClient,
  insertRule,
  listClientServiceIds,
  listClients,
  listRules,
  listServiceAreas,
  listServiceTypes,
  lockClient,
  postcodeExists,
  replaceClientServices,
  setClientStatus,
  updateClient,
  type ClientDetail,
  type ClientListRow,
  type ClientRow,
} from "./repo";
import { encryptSecret, generateWebhookSecret, secretHint } from "@/lib/secrets";
import {
  getDeliverySettings,
  hasWebhookSecret,
  storeWebhookSecret,
  updateDeliverySettings,
  type DeliverySettings,
  deletePause,
  getPause,
  getRoutingPreferences,
  insertPause,
  listPauses,
  listWorkingHours,
  replaceWorkingHours,
  updateRoutingPreferences,
  type PauseRow,
  type RoutingPreferences,
} from "./routing-repo";
import type { DeliverySettingsInput } from "./delivery-schemas";
import type { PauseInput, RoutingPreferencesInput, WorkingWindowInput } from "./routing-schemas";
import {
  CLIENT_STATUS_REASONS,
  statusNeedsReason,
  type ClientInput,
  type ClientStatus,
  type CoverageRuleInput,
} from "./schemas";

export type ClientFailure =
  | "not_found"
  | "not_ready"       // would leave an active client unable to receive any lead
  | "reason_required"
  | "invalid_reason"
  | "duplicate_rule"
  | "unknown_area"
  | "unknown_postcode"
  | "unknown_service"
  | "same_status"
  | "sms_needs_phone"
  | "webhook_needs_secret"
  | "secrets_unavailable";

export type ClientResult<T = object> = ({ ok: true } & T) | { ok: false; code: ClientFailure };

export interface ClientServiceDeps {
  db: Database;
  logger: Logger;
  verticalSlug: string;
  /** Encrypts webhook signing secrets (DELIVERY_SECRETS_KEY). Without it a secret cannot be generated. */
  secretsKey?: Buffer | undefined;
}

/** Fields worth recording in an audit entry (business details only). */
const auditFields = (client: ClientRow | ClientInput) => ({
  name: client.name,
  legal_name: client.legalName ?? null,
  company_number: client.companyNumber ?? null,
  contact_name: client.contactName ?? null,
  contact_email: "contactEmail" in client ? client.contactEmail : null,
  contact_phone_e164: client.contactPhone ?? null,
  accepts_exclusive: client.acceptsExclusive,
  accepts_shared: client.acceptsShared,
});

export function createClientService(config: ClientServiceDeps) {
  const { db, logger, verticalSlug } = config;
  async function verticalId(): Promise<number> {
    const id = await getVerticalId(db, verticalSlug);
    if (id === undefined) throw new Error(`vertical "${verticalSlug}" is not seeded`);
    return id;
  }

  /** An `active` client must be able to receive a lead: at least one service and one include rule. */
  async function isReady(trx: Database, clientId: string): Promise<boolean> {
    return (await countServices(trx, clientId)) > 0 && (await countIncludeRules(trx, clientId)) > 0;
  }

  return {
    async list(): Promise<ClientListRow[]> {
      return listClients(db, await verticalId());
    },

    async detail(id: string): Promise<(ClientDetail & { allServices: Array<{ id: number; slug: string; label: string }>; allAreas: Array<{ id: number; slug: string; name: string }> }) | undefined> {
      const detail = await getClientDetail(db, id);
      if (!detail) return undefined;
      const [allServices, allAreas] = await Promise.all([listServiceTypes(db, await verticalId()), listServiceAreas(db)]);
      return { ...detail, allServices, allAreas };
    },

    async create(input: { operator: Operator; client: ClientInput; requestId: string }): Promise<{ id: string }> {
      // Resolved BEFORE the transaction: asking the pool for a second connection while this transaction holds one is a pool
      // deadlock waiting to happen (with N concurrent creates and a pool of N, every connection waits for another).
      const vertical = await verticalId();
      const id = await db.transaction().execute(async (trx) => {
        const created = await insertClient(trx, vertical, input.client);
        await writeAudit(trx, { actorId: input.operator.id, action: "client.created", entityType: "client", entityId: created, after: { ...auditFields(input.client), status: "prospect" }, requestId: input.requestId });
        return created;
      });
      logger.info({ clientId: id, operatorId: input.operator.id }, "client created");
      return { id };
    },

    async update(input: { operator: Operator; clientId: string; client: ClientInput; requestId: string }): Promise<ClientResult> {
      return db.transaction().execute(async (trx): Promise<ClientResult> => {
        const before = await lockClient(trx, input.clientId);
        if (!before) return { ok: false, code: "not_found" };
        await updateClient(trx, input.clientId, input.client);
        await writeAudit(trx, { actorId: input.operator.id, action: "client.updated", entityType: "client", entityId: input.clientId, before: auditFields(before), after: auditFields(input.client), requestId: input.requestId });
        return { ok: true };
      });
    },

    async setStatus(input: { operator: Operator; clientId: string; status: ClientStatus; reason?: string | undefined; requestId: string }): Promise<ClientResult> {
      if (statusNeedsReason(input.status)) {
        if (!input.reason) return { ok: false, code: "reason_required" };
        if (!(input.reason in CLIENT_STATUS_REASONS)) return { ok: false, code: "invalid_reason" };
      } else if (input.reason !== undefined && input.reason !== "" && !(input.reason in CLIENT_STATUS_REASONS)) {
        return { ok: false, code: "invalid_reason" };
      }
      const result = await db.transaction().execute(async (trx): Promise<ClientResult> => {
        const before = await lockClient(trx, input.clientId);
        if (!before) return { ok: false, code: "not_found" };
        if (before.status === input.status) return { ok: false, code: "same_status" };
        if (input.status === "active" && !(await isReady(trx, input.clientId))) return { ok: false, code: "not_ready" };
        await setClientStatus(trx, input.clientId, input.status);
        await writeAudit(trx, {
          actorId: input.operator.id,
          action: "client.status_changed",
          entityType: "client",
          entityId: input.clientId,
          reason: input.reason || undefined,
          before: { status: before.status },
          after: { status: input.status },
          requestId: input.requestId,
        });
        return { ok: true };
      });
      if (result.ok) logger.info({ clientId: input.clientId, operatorId: input.operator.id, status: input.status }, "client status changed");
      return result;
    },

    async setServices(input: { operator: Operator; clientId: string; serviceSlugs: string[]; requestId: string }): Promise<ClientResult> {
      const types = await listServiceTypes(db, await verticalId());
      const bySlug = new Map(types.map((type) => [type.slug, type]));
      const wanted = [...new Set(input.serviceSlugs)];
      if (wanted.some((slug) => !bySlug.has(slug))) return { ok: false, code: "unknown_service" };
      const ids = wanted.map((slug) => bySlug.get(slug)!.id);

      return db.transaction().execute(async (trx): Promise<ClientResult> => {
        const client = await lockClient(trx, input.clientId);
        if (!client) return { ok: false, code: "not_found" };
        if (client.status === "active" && ids.length === 0) return { ok: false, code: "not_ready" };
        const beforeIds = await listClientServiceIds(trx, input.clientId);
        await replaceClientServices(trx, input.clientId, ids);
        const labelOf = (id: number) => types.find((type) => type.id === id)?.slug ?? String(id);
        await writeAudit(trx, { actorId: input.operator.id, action: "client.services_changed", entityType: "client", entityId: input.clientId, before: { services: beforeIds.map(labelOf).sort() }, after: { services: wanted.sort() }, requestId: input.requestId });
        return { ok: true };
      });
    },

    async addRule(input: { operator: Operator; clientId: string; rule: CoverageRuleInput; requestId: string }): Promise<ClientResult<{ ruleId: string }>> {
      let serviceAreaId: number | undefined;
      if (input.rule.kind === "area") {
        const slug = input.rule.serviceAreaSlug;
        serviceAreaId = (await listServiceAreas(db)).find((area) => area.slug === slug)?.id;
        if (serviceAreaId === undefined) return { ok: false, code: "unknown_area" };
      }
      if (input.rule.kind === "radius" && !(await postcodeExists(db, input.rule.centerPostcode))) return { ok: false, code: "unknown_postcode" };

      return db.transaction().execute(async (trx): Promise<ClientResult<{ ruleId: string }>> => {
        if (!(await lockClient(trx, input.clientId))) return { ok: false, code: "not_found" };
        const ruleId = await insertRule(trx, input.clientId, { mode: input.rule.mode, rule: input.rule, ...(serviceAreaId !== undefined && { serviceAreaId }) });
        if (!ruleId) return { ok: false, code: "duplicate_rule" };
        const label = (await listRules(trx, input.clientId)).find((rule) => rule.id === ruleId)?.label;
        await writeAudit(trx, { actorId: input.operator.id, action: "client.coverage_added", entityType: "client", entityId: input.clientId, after: { mode: input.rule.mode, rule: label }, requestId: input.requestId });
        return { ok: true, ruleId };
      });
    },

    async removeRule(input: { operator: Operator; clientId: string; ruleId: string; requestId: string }): Promise<ClientResult> {
      return db.transaction().execute(async (trx): Promise<ClientResult> => {
        const client = await lockClient(trx, input.clientId);
        if (!client) return { ok: false, code: "not_found" };
        const rules = await listRules(trx, input.clientId);
        const target = rules.find((rule) => rule.id === input.ruleId);
        if (!target) return { ok: false, code: "not_found" };
        if (client.status === "active" && target.mode === "include" && rules.filter((rule) => rule.mode === "include").length === 1) {
          return { ok: false, code: "not_ready" }; // would leave an active client covering nowhere
        }
        await deleteRule(trx, input.clientId, input.ruleId);
        await writeAudit(trx, { actorId: input.operator.id, action: "client.coverage_removed", entityType: "client", entityId: input.clientId, before: { mode: target.mode, rule: target.label }, requestId: input.requestId });
        return { ok: true };
      });
    },

    // ----------------------------------------------------------------------------------------------
    // Routing preferences (stage 4): how often, in what order, when, and when not
    // ----------------------------------------------------------------------------------------------

    async routingPreferences(clientId: string): Promise<{ prefs: RoutingPreferences; hours: WorkingWindowInput[]; pauses: PauseRow[] } | undefined> {
      const prefs = await getRoutingPreferences(db, clientId);
      if (!prefs) return undefined;
      const [hours, pauses] = await Promise.all([listWorkingHours(db, clientId), listPauses(db, clientId)]);
      return { prefs, hours, pauses };
    },

    async setRoutingPreferences(input: { operator: Operator; clientId: string; prefs: RoutingPreferencesInput; requestId: string }): Promise<ClientResult> {
      return db.transaction().execute(async (trx): Promise<ClientResult> => {
        if (!(await lockClient(trx, input.clientId))) return { ok: false, code: "not_found" };
        const before = await getRoutingPreferences(trx, input.clientId);
        await updateRoutingPreferences(trx, input.clientId, input.prefs);
        await writeAudit(trx, {
          actorId: input.operator.id, action: "client.routing_changed", entityType: "client", entityId: input.clientId,
          before: before && { priority: before.priority, weight: before.weight, daily_lead_cap: before.dailyLeadCap, monthly_lead_cap: before.monthlyLeadCap },
          after: { priority: input.prefs.priority, weight: input.prefs.weight, daily_lead_cap: input.prefs.dailyLeadCap, monthly_lead_cap: input.prefs.monthlyLeadCap },
          requestId: input.requestId,
        });
        return { ok: true };
      });
    },

    /** Replaces the whole weekly schedule. No windows = no restriction (available at any time). */
    async setWorkingHours(input: { operator: Operator; clientId: string; windows: WorkingWindowInput[]; requestId: string }): Promise<ClientResult> {
      return db.transaction().execute(async (trx): Promise<ClientResult> => {
        if (!(await lockClient(trx, input.clientId))) return { ok: false, code: "not_found" };
        const before = await listWorkingHours(trx, input.clientId);
        await replaceWorkingHours(trx, input.clientId, input.windows);
        await writeAudit(trx, { actorId: input.operator.id, action: "client.hours_changed", entityType: "client", entityId: input.clientId, before: { windows: before }, after: { windows: input.windows }, requestId: input.requestId });
        return { ok: true };
      });
    },

    async addPause(input: { operator: Operator; clientId: string; pause: PauseInput; requestId: string }): Promise<ClientResult<{ pauseId: string }>> {
      return db.transaction().execute(async (trx): Promise<ClientResult<{ pauseId: string }>> => {
        if (!(await lockClient(trx, input.clientId))) return { ok: false, code: "not_found" };
        const pauseId = await insertPause(trx, input.clientId, input.pause, input.operator.id);
        const stored = await getPause(trx, input.clientId, pauseId);
        await writeAudit(trx, {
          actorId: input.operator.id, action: "client.pause_added", entityType: "client", entityId: input.clientId, reason: input.pause.reason,
          after: { pause_id: pauseId, starts_at: stored?.startsAt.toISOString(), ends_at: stored?.endsAt.toISOString() }, requestId: input.requestId,
        });
        return { ok: true, pauseId };
      });
    },

    // ----------------------------------------------------------------------------------------------
    // Delivery (stage 5): how the business wants to be told
    // ----------------------------------------------------------------------------------------------

    deliverySettings: (clientId: string): Promise<DeliverySettings | undefined> => getDeliverySettings(db, clientId),
    /** Whether this process can create webhook secrets (DELIVERY_SECRETS_KEY is set). */
    canStoreSecrets: (): boolean => config.secretsKey !== undefined,

    async setDeliverySettings(input: { operator: Operator; clientId: string; settings: DeliverySettingsInput; requestId: string }): Promise<ClientResult> {
      return db.transaction().execute(async (trx): Promise<ClientResult> => {
        if (!(await lockClient(trx, input.clientId))) return { ok: false, code: "not_found" };
        const before = await getDeliverySettings(trx, input.clientId);
        if (!before) return { ok: false, code: "not_found" };
        if (input.settings.sms && !before.contactPhone) return { ok: false, code: "sms_needs_phone" };
        if (input.settings.webhook && !(await hasWebhookSecret(trx, input.clientId))) return { ok: false, code: "webhook_needs_secret" };
        await updateDeliverySettings(trx, input.clientId, input.settings, before.mode === "manual");
        await writeAudit(trx, {
          actorId: input.operator.id, action: "client.delivery_changed", entityType: "client", entityId: input.clientId,
          before: { mode: before.mode, notify_email: before.email, notify_sms: before.sms, notify_webhook: before.webhook, webhook_url: before.webhookUrl },
          after: { mode: input.settings.mode, notify_email: input.settings.email, notify_sms: input.settings.sms, notify_webhook: input.settings.webhook, webhook_url: input.settings.webhookUrl },
          requestId: input.requestId,
        });
        return { ok: true };
      });
    },

    /** Generates a new signing secret, stores it ENCRYPTED, and returns it ONCE (the caller shows it to the operator; nothing can read it back). The old one stops working at once. */
    async rotateWebhookSecret(input: { operator: Operator; clientId: string; requestId: string }): Promise<ClientResult<{ secret: string }>> {
      if (!config.secretsKey) return { ok: false, code: "secrets_unavailable" };
      const secret = generateWebhookSecret();
      return db.transaction().execute(async (trx): Promise<ClientResult<{ secret: string }>> => {
        if (!(await lockClient(trx, input.clientId))) return { ok: false, code: "not_found" };
        await storeWebhookSecret(trx, input.clientId, encryptSecret(config.secretsKey!, secret), secretHint(secret));
        await writeAudit(trx, { actorId: input.operator.id, action: "client.webhook_secret_rotated", entityType: "client", entityId: input.clientId, after: { hint: secretHint(secret) }, requestId: input.requestId });
        return { ok: true, secret };
      });
    },

    async removePause(input: { operator: Operator; clientId: string; pauseId: string; requestId: string }): Promise<ClientResult> {
      return db.transaction().execute(async (trx): Promise<ClientResult> => {
        if (!(await lockClient(trx, input.clientId))) return { ok: false, code: "not_found" };
        const pause = await getPause(trx, input.clientId, input.pauseId);
        if (!pause || !(await deletePause(trx, input.clientId, input.pauseId))) return { ok: false, code: "not_found" };
        await writeAudit(trx, {
          actorId: input.operator.id, action: "client.pause_removed", entityType: "client", entityId: input.clientId, reason: pause.reason,
          before: { pause_id: pause.id, starts_at: pause.startsAt.toISOString(), ends_at: pause.endsAt.toISOString() }, requestId: input.requestId,
        });
        return { ok: true };
      });
    },
  };
}

export type ClientService = ReturnType<typeof createClientService>;
