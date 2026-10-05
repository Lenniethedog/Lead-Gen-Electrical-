import { sql } from "kysely";
import type { Database } from "@/lib/db/client";
import { describeRule, type ClientInput, type ClientStatus, type CoverageKind, type CoverageMode, type CoverageRuleInput } from "./schemas";

/** All SQL for clients, their services and coverage rules. Takes a `Database` (possibly a transaction). */

export interface ClientRow {
  id: string;
  name: string;
  legalName: string | null;
  companyNumber: string | null;
  status: ClientStatus;
  contactName: string | null;
  contactEmail: string;
  contactPhone: string | null;
  acceptsExclusive: boolean;
  acceptsShared: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientListRow {
  id: string;
  name: string;
  status: ClientStatus;
  services: number;
  includeRules: number;
  /** Leads this client currently holds (reserved, notified, accepted or disputed). */
  activeLeads: number;
}

export interface CoverageRuleRow {
  id: string;
  mode: CoverageMode;
  kind: CoverageKind;
  label: string;
}

export interface ClientAssignmentRow {
  id: string;
  leadId: string;
  reference: string;
  status: string;
  pricePence: number;
  createdAt: Date;
}

export interface ClientDetail extends ClientRow {
  services: Array<{ id: number; slug: string; label: string }>;
  rules: CoverageRuleRow[];
  assignments: ClientAssignmentRow[];
}

const COLUMNS = [
  "id", "name", "legal_name", "company_number", "status", "contact_name", "contact_email", "contact_phone_e164",
  "accepts_exclusive", "accepts_shared", "notes", "created_at", "updated_at",
] as const;

function toRow(row: {
  id: string; name: string; legal_name: string | null; company_number: string | null; status: ClientStatus; contact_name: string | null;
  contact_email: string; contact_phone_e164: string | null; accepts_exclusive: boolean; accepts_shared: boolean; notes: string | null;
  created_at: Date; updated_at: Date;
}): ClientRow {
  return {
    id: row.id,
    name: row.name,
    legalName: row.legal_name,
    companyNumber: row.company_number,
    status: row.status,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone_e164,
    acceptsExclusive: row.accepts_exclusive,
    acceptsShared: row.accepts_shared,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getVerticalId(db: Database, slug: string): Promise<number | undefined> {
  return (await db.selectFrom("verticals").select("id").where("slug", "=", slug).executeTakeFirst())?.id;
}

export async function listServiceTypes(db: Database, verticalId: number): Promise<Array<{ id: number; slug: string; label: string }>> {
  return db.selectFrom("service_types").select(["id", "slug", "label"]).where("vertical_id", "=", verticalId).where("active", "=", true).orderBy("sort_order").orderBy("id").execute();
}

export async function listServiceAreas(db: Database): Promise<Array<{ id: number; slug: string; name: string }>> {
  return db.selectFrom("service_areas").select(["id", "slug", "name"]).where("active", "=", true).orderBy("name").execute();
}

export async function postcodeExists(db: Database, postcode: string): Promise<boolean> {
  return (await db.selectFrom("postcodes").select("postcode").where("postcode", "=", postcode).executeTakeFirst()) !== undefined;
}

export async function listClients(db: Database, verticalId: number): Promise<ClientListRow[]> {
  const { rows } = await sql<{ id: string; name: string; status: ClientStatus; services: number; include_rules: number; active_leads: number }>`
    select c.id, c.name, c.status,
           (select count(*)::int from client_services s where s.client_id = c.id) as services,
           (select count(*)::int from client_service_areas a where a.client_id = c.id and a.mode = 'include' and a.active) as include_rules,
           (select count(*)::int from lead_assignments l where l.client_id = c.id and l.status in ('reserved', 'notified', 'accepted', 'disputed')) as active_leads
      from clients c
     where c.vertical_id = ${verticalId} and c.deleted_at is null
     order by (c.status = 'active') desc, lower(c.name)`.execute(db);
  return rows.map((row) => ({ id: row.id, name: row.name, status: row.status, services: row.services, includeRules: row.include_rules, activeLeads: row.active_leads }));
}

export async function getClientRow(db: Database, id: string): Promise<ClientRow | undefined> {
  const row = await db.selectFrom("clients").select(COLUMNS).where("id", "=", id).where("deleted_at", "is", null).executeTakeFirst();
  return row ? toRow(row) : undefined;
}

/** Locks the client row for the rest of the transaction: serialises changes to one client's rules, services and status. */
export async function lockClient(db: Database, id: string): Promise<ClientRow | undefined> {
  const row = await db.selectFrom("clients").select(COLUMNS).where("id", "=", id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
  return row ? toRow(row) : undefined;
}

export async function listRules(db: Database, clientId: string): Promise<CoverageRuleRow[]> {
  const rows = await db
    .selectFrom("client_service_areas as a")
    .leftJoin("service_areas as sa", "sa.id", "a.service_area_id")
    .select(["a.id", "a.mode", "a.kind", "a.outward", "a.sector", "a.postcode_prefix", "a.center_postcode", "a.radius_m", "sa.name as area_name"])
    .where("a.client_id", "=", clientId)
    .where("a.active", "=", true)
    .orderBy("a.mode") // enum order: include before exclude
    .orderBy("a.kind")
    .orderBy("a.created_at")
    .execute();
  return rows.map((row) => ({ id: row.id, mode: row.mode, kind: row.kind, label: describeRule(row, row.area_name) }));
}

export async function getClientDetail(db: Database, id: string): Promise<ClientDetail | undefined> {
  const client = await getClientRow(db, id);
  if (!client) return undefined;
  const [services, rules, assignments] = await Promise.all([
    db
      .selectFrom("client_services as cs")
      .innerJoin("service_types as st", "st.id", "cs.service_type_id")
      .select(["st.id", "st.slug", "st.label"])
      .where("cs.client_id", "=", id)
      .orderBy("st.sort_order")
      .execute(),
    listRules(db, id),
    db
      .selectFrom("lead_assignments as a")
      .innerJoin("leads as l", "l.id", "a.lead_id")
      .select(["a.id", "a.lead_id", "l.reference", "a.status", "a.price_pence", "a.created_at"])
      .where("a.client_id", "=", id)
      .orderBy("a.created_at", "desc")
      .limit(20)
      .execute(),
  ]);
  return {
    ...client,
    services,
    rules,
    assignments: assignments.map((row) => ({ id: row.id, leadId: row.lead_id, reference: row.reference, status: row.status, pricePence: row.price_pence, createdAt: row.created_at })),
  };
}

export async function insertClient(db: Database, verticalId: number, input: ClientInput): Promise<string> {
  const row = await db
    .insertInto("clients")
    .values({
      vertical_id: verticalId,
      name: input.name,
      legal_name: input.legalName ?? null,
      company_number: input.companyNumber ?? null,
      contact_name: input.contactName ?? null,
      contact_email: input.contactEmail,
      contact_phone_e164: input.contactPhone ?? null,
      accepts_exclusive: input.acceptsExclusive,
      accepts_shared: input.acceptsShared,
      notes: input.notes ?? null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function updateClient(db: Database, id: string, input: ClientInput): Promise<void> {
  await db
    .updateTable("clients")
    .set({
      name: input.name,
      legal_name: input.legalName ?? null,
      company_number: input.companyNumber ?? null,
      contact_name: input.contactName ?? null,
      contact_email: input.contactEmail,
      contact_phone_e164: input.contactPhone ?? null,
      accepts_exclusive: input.acceptsExclusive,
      accepts_shared: input.acceptsShared,
      notes: input.notes ?? null,
    })
    .where("id", "=", id)
    .execute();
}

export async function setClientStatus(db: Database, id: string, status: ClientStatus): Promise<void> {
  await db.updateTable("clients").set({ status }).where("id", "=", id).execute();
}

export async function countServices(db: Database, clientId: string): Promise<number> {
  const row = await db.selectFrom("client_services").select((eb) => eb.fn.countAll<string>().as("n")).where("client_id", "=", clientId).executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function countIncludeRules(db: Database, clientId: string): Promise<number> {
  const row = await db
    .selectFrom("client_service_areas")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("client_id", "=", clientId)
    .where("mode", "=", "include")
    .where("active", "=", true)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export async function listClientServiceIds(db: Database, clientId: string): Promise<number[]> {
  return (await db.selectFrom("client_services").select("service_type_id").where("client_id", "=", clientId).execute()).map((row) => row.service_type_id);
}

/** Makes the client's offered services exactly `serviceTypeIds`. */
export async function replaceClientServices(db: Database, clientId: string, serviceTypeIds: number[]): Promise<void> {
  const deletion = db.deleteFrom("client_services").where("client_id", "=", clientId);
  await (serviceTypeIds.length > 0 ? deletion.where("service_type_id", "not in", serviceTypeIds) : deletion).execute();
  if (serviceTypeIds.length > 0) {
    await db
      .insertInto("client_services")
      .values(serviceTypeIds.map((service_type_id) => ({ client_id: clientId, service_type_id })))
      .onConflict((conflict) => conflict.columns(["client_id", "service_type_id"]).doNothing())
      .execute();
  }
}

export interface ResolvedRule {
  mode: CoverageMode;
  rule: CoverageRuleInput;
  serviceAreaId?: number;
}

/** Returns the new rule's id, or undefined if the client already has exactly this rule (unique index). */
export async function insertRule(db: Database, clientId: string, resolved: ResolvedRule): Promise<string | undefined> {
  const { rule } = resolved;
  const row = await db
    .insertInto("client_service_areas")
    .values({
      client_id: clientId,
      mode: resolved.mode,
      kind: rule.kind,
      outward: rule.kind === "outward" ? rule.outward : null,
      sector: rule.kind === "sector" ? rule.sector : null,
      postcode_prefix: rule.kind === "postcode_prefix" ? rule.postcodePrefix : null,
      service_area_id: rule.kind === "area" ? (resolved.serviceAreaId ?? null) : null,
      center_postcode: rule.kind === "radius" ? rule.centerPostcode : null,
      radius_m: rule.kind === "radius" ? rule.radiusMetres : null,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .executeTakeFirst();
  return row?.id;
}

export async function deleteRule(db: Database, clientId: string, ruleId: string): Promise<CoverageRuleRow | undefined> {
  const [existing] = (await listRules(db, clientId)).filter((rule) => rule.id === ruleId);
  if (!existing) return undefined;
  await db.deleteFrom("client_service_areas").where("id", "=", ruleId).where("client_id", "=", clientId).execute();
  return existing;
}
