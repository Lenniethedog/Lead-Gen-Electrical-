import { expect, test } from "@playwright/test";
import { E2E_ACCESS } from "./access";
import { createLead, e164, signInAs, signInAsOwner } from "./api";
import { createActiveClient, expectNoViolations, problem, unique } from "./flows";
import { SERVICE, uniquePerson, withDb } from "./helpers";

/**
 * Stage 3 in a real browser, against the production build: create and activate a client, ask the coverage tester, set a price,
 * hand a lead to a business, send it, take it back, move it, and honour a privacy request, as ordinary staff and as an owner.
 * Runs on the phone and desktop projects: the operator will often work from a phone.
 */
test.describe("clients and coverage", () => {
  test("creating a client, the activation guard, coverage rules and the tester", async ({ page }) => {
    await signInAs(page);
    const name = `E2E Electrical ${unique()}`;

    await page.goto("/admin/clients/new");
    // The form keeps what was typed and names what is wrong.
    await page.getByLabel("Business name").fill(name);
    await page.getByLabel("Their email").fill("not an email");
    await page.getByRole("button", { name: "Create client" }).click();
    await expect(page.getByText("Please fix the highlighted fields.")).toBeVisible();
    await expect(page.getByLabel("Business name")).toHaveValue(name);
    await expect(page.getByText("Enter a valid email address")).toBeVisible();

    await page.getByLabel("Their email").fill(`${unique()}@electrician.example`);
    await page.getByRole("button", { name: "Create client" }).click();
    await expect(page.getByRole("status").first()).toContainText("Client created");
    await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
    await expect(page.getByText("Prospect", { exact: true }).first()).toBeVisible();

    // Cannot go active with nothing to receive.
    await page.getByLabel("Change to").selectOption("active");
    await page.getByRole("button", { name: "Change status" }).click();
    await expect(problem(page)).toContainText("unable to receive any lead");

    await page.getByLabel(SERVICE).check();
    await page.getByRole("button", { name: "Save services" }).click();
    await expect(page.getByRole("status").first()).toContainText("Services saved");
    await page.getByLabel("A postcode district: District").fill("BR6");
    await page.locator("form").filter({ has: page.getByLabel("A postcode district: District") }).getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("status").first()).toContainText("Coverage rule added");
    await expect(page.getByText("Postcode district BR6")).toBeVisible();
    // A malformed rule explains itself.
    await page.getByLabel("A postcode district: District").fill("NOPE");
    await page.locator("form").filter({ has: page.getByLabel("A postcode district: District") }).getByRole("button", { name: "Add" }).click();
    await expect(problem(page)).toContainText("postcode district");
    // A duplicate is refused.
    await page.getByLabel("A postcode district: District").fill("br6");
    await page.locator("form").filter({ has: page.getByLabel("A postcode district: District") }).getByRole("button", { name: "Add" }).click();
    await expect(problem(page)).toContainText("already has exactly that rule");

    await page.getByLabel("Change to").selectOption("active");
    await page.getByRole("button", { name: "Change status" }).click();
    await expect(page.getByRole("status").first()).toContainText("Status changed");

    // The tester agrees, and says why not for a postcode they don't cover.
    await page.goto("/admin/coverage?postcode=BR6+0AA&service=fault_repair&sale=exclusive");
    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row).toContainText("Eligible");
    await expect(row).toContainText("Postcode district BR6");
    await page.goto("/admin/coverage?postcode=TN13+1AA&service=fault_repair&sale=exclusive");
    const away = page.getByRole("row").filter({ hasText: name });
    await expect(away).toContainText("Not eligible");
    await expect(away).toContainText("No coverage rule includes this postcode");
    await page.goto("/admin/coverage?postcode=NOTAPOSTCODE");
    await expect(problem(page)).toContainText("does not look like a UK postcode");
  });

  test("a client's page, the clients list and the tester are accessible", async ({ page }) => {
    await signInAs(page);
    const name = await createActiveClient(page, `E2E A11y Electrical ${unique()}`);
    await expectNoViolations(page, "client detail");
    await page.goto("/admin/clients");
    await expect(page.getByRole("link", { name })).toBeVisible();
    await expectNoViolations(page, "clients list");
    await page.goto("/admin/clients/new");
    await expectNoViolations(page, "new client");
    await page.goto("/admin/coverage?postcode=BR6+0AA&service=fault_repair&sale=exclusive");
    await expectNoViolations(page, "coverage tester with results");
  });

  test("unknown or malformed client ids are a 404", async ({ page }) => {
    await signInAs(page);
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      expect((await page.goto(`/admin/clients/${id}`))?.status(), id).toBe(404);
    }
  });
});

test.describe("pricing", () => {
  test("setting a price replaces the old one, keeps the history, and rejects nonsense", async ({ page }) => {
    await signInAs(page);
    await page.goto("/admin/pricing");
    await page.getByLabel("Service", { exact: true }).selectOption("ev_charger");
    await page.getByLabel("Price per lead (£)").fill("lots");
    await page.getByRole("button", { name: "Save price" }).click();
    await expect(problem(page)).toContainText("Enter a price in pounds");

    await page.getByLabel("Service", { exact: true }).selectOption("ev_charger");
    // A price no earlier run used, so the history assertion below cannot pass on a previous run's leftovers.
    // Taken from the clock (to the millisecond, £100.00 to £499.99, never the £49 used next) rather than a small random range, which the
    // shared dev database eventually repeats.
    const firstPrice = (10_000 + (Date.now() % 40_000)) / 100;
    const firstText = `£${firstPrice.toFixed(2)}`;
    await page.getByLabel("Price per lead (£)").fill(firstPrice.toFixed(2));
    await page.getByRole("button", { name: "Save price" }).click();
    await expect(page.getByRole("status")).toContainText("Price saved");
    await expect(page.getByRole("row").filter({ hasText: "EV charger" })).toContainText(firstText);

    await page.getByLabel("Service", { exact: true }).selectOption("ev_charger");
    await page.getByLabel("Price per lead (£)").fill("49");
    await page.getByRole("button", { name: "Save price" }).click();
    await expect(page.getByRole("row").filter({ hasText: "EV charger" })).toContainText("£49.00");
    await expect(page.getByRole("row").filter({ hasText: "EV charger" })).not.toContainText(firstText);
    await expect(page.getByRole("heading", { name: "Price history" })).toBeVisible();
    await expect(page.getByText(`${firstText} ·`)).toBeVisible();
    await expectNoViolations(page, "pricing");
  });
});

test.describe("handing a lead to a business", () => {
  test("assign, send, take back, assign again and move it, with the message and the history", async ({ page, request, baseURL }) => {
    await signInAs(page);
    // A general price so the assign form does not ask for one.
    // A price for exactly what the test lead is (electrical fault repair, urgent): the most specific rule wins, so this holds even when the database
    // already has a cheaper or dearer general rule (the demo data has an urgent rule of its own).
    await page.goto("/admin/pricing");
    await page.getByLabel("Service", { exact: true }).selectOption("fault_repair");
    await page.getByLabel("Urgency").selectOption("emergency");
    await page.getByLabel("Price per lead (£)").fill("35");
    await page.getByRole("button", { name: "Save price" }).click();
    await expect(page.getByRole("status")).toContainText("Price saved");

    const first = await createActiveClient(page, `E2E First ${unique()}`);
    const second = await createActiveClient(page, `E2E Second ${unique()}`);
    const person = uniquePerson("Handover");
    const reference = await createLead(request, baseURL!, person, "new");

    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await expect(page.getByRole("heading", { name: "Hand this lead to a business" })).toBeVisible();

    // Assign.
    await page.locator("#assign-client").selectOption({ label: `${first} (covers this postcode)` });
    await expect(page.getByText("£35.00")).toBeVisible();
    await page.getByRole("button", { name: "Assign lead" }).click();
    await expect(page.getByRole("status").first()).toContainText("Lead assigned");
    // Assigned but not yet sent: the badge says a person still has to send it (stage 4 made that visible).
    await expect(page.getByText("Assigned: send it", { exact: true }).first()).toBeVisible();
    // The message carries what the business needs, and only now.
    const message = page.getByLabel(/Message for/);
    await expect(message).toHaveValue(new RegExp(e164(person.phone).replace("+", "\\+")));
    await expect(message).toHaveValue(/sent to you only/);
    await expect(message).toHaveValue(new RegExp(reference));

    // Send.
    await page.getByRole("button", { name: /I.ve sent it/ }).click();
    await expect(page.getByRole("status").first()).toContainText("Marked as sent");
    await expect(page.getByText("Sent", { exact: true }).first()).toBeVisible();

    // Take it back: a reason is required (the form will not submit without one).
    await page.getByText("Take it back", { exact: true }).first().click();
    await page.getByRole("button", { name: "Take it back" }).click();
    await expect(page.getByRole("heading", { name: "Businesses" })).toBeVisible();
    await expect(page.getByLabel("Why?")).toBeVisible(); // still there: nothing was sent
    await page.getByLabel("Why?").selectOption("client_declined");
    await page.getByRole("button", { name: "Take it back" }).click();
    await expect(page.getByRole("status").first()).toContainText("Taken back");
    await expect(page.getByRole("heading", { name: "Hand this lead to a business" })).toBeVisible();

    // Assign again, then move it to the second business with a mandatory reason.
    await page.locator("#assign-client").selectOption({ label: `${first} (covers this postcode)` });
    await page.getByRole("button", { name: "Assign lead" }).click();
    await expect(page.getByRole("status").first()).toContainText("Lead assigned");
    await page.getByText("Move it to another business").click();
    await page.getByLabel("Move to").selectOption({ label: `${second} (covers this postcode)` });
    await page.getByLabel("Why move it?").selectOption("no_response");
    await page.getByRole("button", { name: "Move lead" }).click();
    await expect(page.getByRole("status").first()).toContainText("Moved to the new business");
    await expect(page.getByRole("heading", { name: second })).toBeVisible();
    await expect(page.getByRole("heading", { name: first }).first()).toBeVisible(); // the old hold stays in the history
    await expect(page.getByText("Taken back", { exact: true }).first()).toBeVisible();

    // The database agrees: one active holder, the right one, and a complete audit trail with the operator.
    const rows = await withDb(async (client) =>
      (
        await client.query(
          `select c.name, a.status from lead_assignments a join clients c on c.id = a.client_id join leads l on l.id = a.lead_id
            where l.reference = $1 order by a.created_at`,
          [reference],
        )
      ).rows,
    );
    expect(rows.map((row) => [row.name, row.status])).toEqual([[first, "cancelled"], [first, "cancelled"], [second, "reserved"]]);
    const audit = await withDb(async (client) =>
      (await client.query(`select a.action, a.reason, o.email from audit_logs a join leads l on l.id::text = a.entity_id left join operators o on o.id = a.actor_id where l.reference = $1 order by a.id`, [reference])).rows,
    );
    expect(audit.map((entry) => [entry.action, entry.reason, entry.email])).toEqual([
      ["assignment.created", "manual_assignment", E2E_ACCESS.operator],
      ["assignment.notified", null, E2E_ACCESS.operator],
      ["assignment.cancelled", "client_declined", E2E_ACCESS.operator],
      ["assignment.created", "manual_assignment", E2E_ACCESS.operator],
      ["assignment.reassigned", "no_response", E2E_ACCESS.operator],
    ]);
    await expectNoViolations(page, "lead page with an active assignment");

    // Moved but not yet sent to the second business, so it still needs a person: it is in "Needs action" until it is sent (stage 4).
    await page.goto("/admin/leads");
    await expect(page.getByRole("row").filter({ hasText: reference })).toContainText("Assigned: send it");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await page.getByRole("button", { name: /I.ve sent it/ }).click();
    await expect(page.getByRole("status").first()).toContainText("Marked as sent");

    // Sent: the lead now lives under "Assigned", not "Needs action".
    await page.goto("/admin/leads");
    await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(0);
    await page.getByRole("link", { name: "Assigned" }).click();
    await expect(page.getByRole("row").filter({ hasText: reference })).toContainText("Assigned");
  });

  test("a business that does not cover the postcode is refused with the reason, unless the operator confirms an exception", async ({ page, request, baseURL }) => {
    await signInAs(page);
    await page.goto("/admin/pricing");
    await page.getByLabel("Price per lead (£)").fill("35");
    await page.getByRole("button", { name: "Save price" }).click();
    const elsewhere = await createActiveClient(page, `E2E Elsewhere ${unique()}`, "DA1");
    const reference = await createLead(request, baseURL!, uniquePerson("Coverage"), "new");

    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await page.locator("#assign-client").selectOption({ label: `${elsewhere} (outside coverage)` });
    await page.getByRole("button", { name: "Assign lead" }).click();
    await expect(problem(page)).toContainText("does not cover this postcode");
    await expect(problem(page)).toContainText("No coverage rule includes this postcode");
    await expect(page.getByRole("heading", { name: "Hand this lead to a business" })).toBeVisible(); // nothing changed

    await page.locator("#assign-client").selectOption({ label: `${elsewhere} (outside coverage)` });
    await page.getByLabel(/Hand it over even though/).check();
    await page.getByRole("button", { name: "Assign lead" }).click();
    await expect(page.getByRole("status").first()).toContainText("Lead assigned");
    const reason = await withDb(async (client) => (await client.query(`select a.reason from audit_logs a join leads l on l.id::text = a.entity_id where l.reference = $1 and a.action = 'assignment.created'`, [reference])).rows[0].reason);
    expect(reason).toBe("coverage_exception");
  });
});

test.describe("privacy requests", () => {
  test("any operator can record a withdrawal; the business that was sent the details is listed to be told", async ({ page, request, baseURL }) => {
    await signInAs(page);
    await page.goto("/admin/pricing");
    await page.getByLabel("Price per lead (£)").fill("35");
    await page.getByRole("button", { name: "Save price" }).click();
    const business = await createActiveClient(page, `E2E Notify ${unique()}`);
    const person = uniquePerson("Withdraw");
    const reference = await createLead(request, baseURL!, person, "new");

    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await page.locator("#assign-client").selectOption({ label: `${business} (covers this postcode)` });
    await page.getByRole("button", { name: "Assign lead" }).click();
    await page.getByRole("button", { name: /I.ve sent it/ }).click();
    await expect(page.getByRole("status").first()).toContainText("Marked as sent");

    await page.getByRole("button", { name: "They withdrew consent" }).click();
    await expect(page.getByRole("status").first()).toContainText("Consent withdrawn");
    await expect(page.getByText("This person withdrew consent.")).toBeVisible();
    await expect(page.getByText("Tell the businesses that were sent their details")).toBeVisible();
    await expect(page.getByText(`${business}: `)).toBeVisible();
    // The lead is closed and the business no longer holds it.
    await expect(page.getByRole("heading", { name: "Hand this lead to a business" })).toHaveCount(0);
    await expect(page.getByText("Taken back", { exact: true }).first()).toBeVisible();
    // Ordinary staff cannot erase.
    await expect(page.getByRole("button", { name: /Erase this person/ })).toHaveCount(0);
    await expect(page.getByText("Only an owner can erase personal data")).toBeVisible();
    await expectNoViolations(page, "lead page after a withdrawal");
  });

  test("an owner can erase a lead: the personal data is gone from the page and the database", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    const person = uniquePerson("Erase");
    const reference = await createLead(request, baseURL!, person, "new");

    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await expect(page.getByText(person.name, { exact: true })).toBeVisible(); // visible before

    await page.getByRole("button", { name: /Erase this person/ }).click(); // a reason is required: the form does not submit
    await expect(page.getByLabel("Why?")).toBeVisible();
    await page.getByLabel("Why?").selectOption("consumer_request");
    await page.getByRole("button", { name: /Erase this person/ }).click();
    await expect(page.getByRole("status").first()).toContainText("Personal data erased");
    await expect(page.getByText("Contact details have been erased.")).toBeVisible();
    await expect(page.getByText(person.name, { exact: true })).toHaveCount(0);
    expect(await page.locator("main").innerText()).not.toContain(e164(person.phone));

    const row = await withDb(async (client) =>
      (await client.query(`select c.full_name, c.phone_e164, c.email, l.postcode, l.status from leads l join lead_contacts c on c.lead_id = l.id where l.reference = $1`, [reference])).rows[0],
    );
    expect(row).toEqual({ full_name: null, phone_e164: null, email: null, postcode: null, status: "invalid" });
    const owner = await withDb(async (client) =>
      (await client.query(`select a.action, o.email from audit_logs a join leads l on l.id::text = a.entity_id join operators o on o.id = a.actor_id where l.reference = $1`, [reference])).rows,
    );
    expect(owner).toEqual([{ action: "privacy.lead_erased", email: E2E_ACCESS.owner }]);
  });

  test("ordinary staff are not offered the erase action", async ({ page, request, baseURL }) => {
    await signInAs(page);
    const reference = await createLead(request, baseURL!, uniquePerson("NoErase"), "new");
    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await expect(page.getByRole("button", { name: /Erase this person/ })).toHaveCount(0);
    await expect(page.getByText("Only an owner can erase personal data")).toBeVisible();
  });
});
