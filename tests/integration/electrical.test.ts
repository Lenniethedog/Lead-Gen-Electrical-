import { afterEach, describe, expect, it } from "vitest";
import { buildLeadService, command, validSubmission } from "../helpers/fixtures";
import { buildRouting } from "../helpers/routing";

/**
 * What is particular to electrical work, end to end through the real lead service and router against PostgreSQL.
 *
 * A business that does EV chargers often does not do inspection and testing (or the other way round), so each is its own
 * service (docs/00 E2). Routing already matches on service; these tests prove that is enough: an EV charger job is never
 * handed to a business that only does repairs, and an EICR never to one that only does chargers, however they are ranked.
 */

let env: Awaited<ReturnType<typeof buildRouting>> | undefined;
afterEach(async () => {
  await env?.destroy();
  env = undefined;
});

let n = 9_000;
const next = () => (n += 1);

async function business(name: string, services: string[], outward = ["BR6"]) {
  const id = await env!.s.activeClient(env!.owner, { name, outward });
  const result = await env!.s.clients.setServices({ operator: env!.owner, clientId: id, serviceSlugs: services, requestId: env!.s.rid() });
  if (!result.ok) throw new Error(`services: ${result.code}`);
  return id;
}

const chargerJob = () => validSubmission({ service: "ev_charger", scope: "home_charger" }, next());
const inspectionJob = () => validSubmission({ service: "eicr", scope: "landlord_certificate" }, next());

describe("each kind of electrical job goes to a business that does it", () => {
  it("routes each job to the business that offers that service, even when the other business is ranked first", async () => {
    env = await buildRouting();
    const inspector = await business("Test And Inspect Electrical", ["eicr", "fault_repair"]);
    const chargers = await business("Charge Point Electrical", ["ev_charger"]);
    // The charger business is the router's favourite: it must still never be given an EICR, nor the inspector a charger.
    await env.prefs(chargers, { priority: 1 });
    await env.turnOn();

    const leads = buildLeadService(env.t.db);
    const chargerLead = await leads.submit(command(chargerJob()));
    const inspectionLead = await leads.submit(command(inspectionJob()));

    const routed = new Map<string, string | undefined>();
    for (let i = 0; i < 2; i += 1) {
      const result = await env.routing.routeNext();
      expect(result?.outcome).toBe("assigned");
      if (result?.outcome === "assigned") routed.set(result.leadId, result.clientId);
    }
    expect(routed.get(chargerLead.leadId)).toBe(chargers);
    expect(routed.get(inspectionLead.leadId)).toBe(inspector);
  });

  it("parks an EV charger job rather than give it to a business that does not offer chargers", async () => {
    env = await buildRouting();
    await business("Repairs Only Electrical", ["fault_repair", "lighting_sockets"]);
    await env.turnOn();

    const chargerLead = await buildLeadService(env.t.db).submit(command(chargerJob()));
    const result = await env.routing.routeNext();
    expect(result).toMatchObject({ leadId: chargerLead.leadId, outcome: "no_candidates", reason: "no_eligible_client" });
    expect(await env.assignmentsOf(chargerLead.leadId)).toEqual([]);
    expect(await env.leadRow(chargerLead.leadId)).toMatchObject({ status: "unroutable" }); // parked for a person ("Needs action")
  });
});

describe("an electrical enquiry as stored", () => {
  it("records the electrical service, the answer to the follow-up question, and the electrical consent wording", async () => {
    env = await buildRouting();
    const lead = await buildLeadService(env.t.db).submit(command(validSubmission({ service: "consumer_unit", scope: "replace_fuse_box" }, next())));
    const row = await env.t.admin
      .selectFrom("leads as l")
      .innerJoin("verticals as v", "v.id", "l.vertical_id")
      .innerJoin("service_types as s", "s.id", "l.service_type_id")
      .innerJoin("consent_records as c", "c.lead_id", "l.id")
      .innerJoin("consent_texts as ct", "ct.id", "c.consent_text_id")
      .select(["v.slug as vertical", "s.slug as service", "l.details", "ct.body"])
      .where("l.id", "=", lead.leadId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ vertical: "electrical", service: "consumer_unit", details: { scope: "replace_fuse_box" } });
    expect(row.body).toContain("one local electrical business that covers my area");
    expect(row.body).toContain("about my electrical enquiry");
  });
});
