import { expect, test, type Page } from "@playwright/test";
import { createLead, signInAs, signInAsOwner } from "./api";
import { createActiveClient, expectNoViolations, problem, routeNow, unique } from "./flows";
import { uniquePerson, withDb } from "./helpers";

/**
 * Automatic routing (stage 4) in a real browser, against the production build: an owner switches routing on, a new lead is handed to the
 * right business and the operator can see why, a lead nobody can take waits for a person with the reasons, rules and a business's own
 * preferences are edited, and staff can look but not change. Runs on the phone and desktop projects.
 *
 * The router itself runs in this process (`routeNow`): there is no worker in the browser tests. The worker's wake-up is proved against the
 * real process in tests/integration/worker-process.test.ts.
 */
const setRouting = (enabled: boolean) =>
  withDb(async (client) => {
    await client.query("update routing_settings set enabled = $1, enabled_at = case when $1 then now() else enabled_at end", [enabled]);
  });

test.beforeAll(async () => {
  // Earlier runs of this suite left businesses behind: take them out of automatic routing so a fresh run is decided between ITS businesses.
  await withDb(async (client) => {
    await client.query("update clients set weight = 0 where name like 'E2E Route%'");
  });
});
test.beforeEach(async () => {
  await setRouting(false);
});
test.afterAll(async () => {
  await setRouting(false);
});

/** Sets a business's routing preferences through its page. */
async function setPrefs(page: Page, values: { priority?: string; weight?: string; daily?: string; monthly?: string }) {
  const section = page.locator("#routing");
  if (values.priority !== undefined) await section.getByLabel("Priority").fill(values.priority);
  if (values.weight !== undefined) await section.getByLabel("Weight").fill(values.weight);
  if (values.daily !== undefined) await section.getByLabel("Most leads a day").fill(values.daily);
  if (values.monthly !== undefined) await section.getByLabel("Most leads a month").fill(values.monthly);
  await section.getByRole("button", { name: "Save", exact: true }).click();
}

test.describe("the switch", () => {
  test("an owner switches routing on (after confirming) and off; staff can only look", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/admin/routing");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Routing");
    await expect(page.locator("#switch-heading + span")).toHaveText("Off");

    // Switching on needs a deliberate tick.
    await page.getByRole("button", { name: "Switch routing on" }).click();
    await expect(problem(page)).toContainText("Tick the box");
    await expect(page.locator("#switch-heading + span")).toHaveText("Off");
    await page.getByLabel(/I understand new leads will be assigned/).check();
    await page.getByRole("button", { name: "Switch routing on" }).click();
    await expect(page.getByRole("status").first()).toContainText("Automatic routing is ON");
    await expect(page.locator("#switch-heading + span")).toHaveText("On");
    await expect(page.getByText(/On since/)).toBeVisible();

    // Staff see the state and the rules, and no controls.
    const staff = await page.context().browser()!.newContext({ baseURL: page.url().split("/admin")[0] });
    const staffPage = await staff.newPage();
    await signInAs(staffPage);
    await staffPage.goto("/admin/routing");
    await expect(staffPage.locator("#switch-heading + span")).toHaveText("On");
    await expect(staffPage.getByText("Only an owner can switch routing on or off, or change the rules.")).toBeVisible();
    await expect(staffPage.getByRole("button", { name: /Switch routing/ })).toHaveCount(0);
    await expect(staffPage.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await staff.close();

    await page.getByRole("button", { name: "Switch routing off" }).click();
    await expect(page.getByRole("status").first()).toContainText("Automatic routing is OFF");
    await expect(page.locator("#switch-heading + span")).toHaveText("Off");
  });
});

test.describe("a new lead", () => {
  test("is handed to the right business, the operator can see why, and still sends it", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    const first = await createActiveClient(page, `E2E Route First ${unique()}`);
    await setPrefs(page, { priority: "0" });
    await expect(page.getByRole("status").first()).toContainText("Routing preferences saved");
    const second = await createActiveClient(page, `E2E Route Second ${unique()}`);
    await setPrefs(page, { priority: "5" });
    await expect(page.getByRole("status").first()).toContainText("Routing preferences saved");

    await page.goto("/admin/routing");
    await page.getByLabel(/I understand new leads will be assigned/).check();
    await page.getByRole("button", { name: "Switch routing on" }).click();
    await expect(page.getByRole("status").first()).toContainText("Automatic routing is ON");

    const reference = await createLead(request, baseURL!, uniquePerson("Routed"), "new");
    expect(await routeNow()).toMatchObject({ assigned: 1, errors: 0 });

    // It is in "Needs action", assigned, and says a person still has to send it.
    await page.goto("/admin/leads");
    const row = page.getByRole("row").filter({ hasText: reference });
    await expect(row).toContainText("Assigned: send it");
    await row.getByRole("link", { name: reference }).click();

    // The panel names the business and shows every candidate's verdict.
    const routing = page.locator("#routing");
    await expect(routing).toContainText(`The router chose ${first}`);
    await routing.getByText("Why this result").click();
    await expect(routing.getByRole("row").filter({ hasText: first })).toContainText("Chosen");
    await expect(routing.getByRole("row").filter({ hasText: second })).toContainText("Next in line (2)");
    await expect(page.getByLabel(/Message for/)).toBeVisible();

    // The live "what would happen now" answer says the router would leave an assigned lead alone, and why.
    await routing.getByRole("link", { name: /Who would get this lead/ }).click();
    await expect(routing).toContainText("It would leave this lead alone");
    await expect(routing).toContainText("not waiting to be routed");
    await expectNoViolations(page, "lead page with the routing panel and a dry run");

    // Sending it takes it out of Needs action.
    await page.getByRole("button", { name: /I.ve sent it/ }).click();
    await expect(page.getByRole("status").first()).toContainText("Marked as sent");
    await page.goto("/admin/leads");
    await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(0);
    await page.getByRole("link", { name: "Assigned" }).click();
    await expect(page.getByRole("row").filter({ hasText: reference })).toContainText("Assigned");
  });

  test("that nobody can take waits for a person, with the reasons, and can still be handed over by hand", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    // The businesses these tests create offer roof repair only, so a chimney job in BR6 has no business to go to.
    const outsider = await createActiveClient(page, `E2E Route Outsider ${unique()}`);
    await setRouting(true);

    const reference = await createLead(request, baseURL!, uniquePerson("Nobody"), "new", { service: "chimney", scope: "repair_repoint" });
    expect(await routeNow()).toMatchObject({ unroutable: 1, assigned: 0, errors: 0 });

    await page.goto("/admin/leads");
    const row = page.getByRole("row").filter({ hasText: reference });
    await expect(row).toContainText("Nobody could take it");
    await row.getByRole("link", { name: reference }).click();

    const routing = page.locator("#routing");
    await expect(routing).toContainText("No business could take it");
    await expect(routing.getByText(/Businesses that do not cover this lead \(\d+\)/)).toBeVisible();
    await expect(routing).toContainText("The client does not offer this service");
    await expectNoViolations(page, "lead page nobody could take");

    // A person hands it over by hand, outside the business's coverage, with the exception recorded.
    await page.locator("#assign-client").selectOption({ label: `${outsider} (outside coverage)` });
    await page.getByLabel(/Hand it over even though/).check();
    await page.getByRole("button", { name: "Assign lead" }).click();
    await expect(page.getByRole("status").first()).toContainText("Lead assigned");
    await expect(page.getByText(`The router chose`)).toHaveCount(0); // the latest routing run still says nobody could take it
  });

  test("is left alone, with the reason, when it arrived before routing was switched on", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    await setRouting(false);
    const reference = await createLead(request, baseURL!, uniquePerson("Early"), "new");
    await setRouting(true);
    expect(await routeNow()).toMatchObject({ routed: 0 });

    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await page.locator("#routing").getByRole("link", { name: /Who would get this lead/ }).click();
    await expect(page.locator("#routing")).toContainText("arrived before automatic routing was switched on");
  });
});

test.describe("the rules", () => {
  test("an owner edits a setting and reorders the tie-breakers; it is validated; staff see them read-only", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/admin/routing");
    const hours = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Working hours" }) });
    await expect(hours.getByLabel("Stop this many minutes before closing")).toHaveValue("15");

    await hours.getByLabel("Stop this many minutes before closing").fill("500");
    await hours.getByRole("button", { name: "Save", exact: true }).click();
    await expect(problem(page)).toContainText("whole number from 0 to 120");

    await hours.getByLabel("Stop this many minutes before closing").fill("30");
    await hours.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText("Rule saved");
    await expect(hours.getByLabel("Stop this many minutes before closing")).toHaveValue("30");

    // The tie-breakers: priority moves later, then back.
    const priority = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Priority", exact: true }) });
    await expect(priority).toContainText("Tie-breaker 1 of 3");
    await priority.getByRole("button", { name: "Apply Priority later" }).click();
    await expect(page.getByRole("status").first()).toContainText("Order changed");
    await expect(priority).toContainText("Tie-breaker 2 of 3");
    await priority.getByRole("button", { name: "Apply Priority earlier" }).click();
    await expect(priority).toContainText("Tie-breaker 1 of 3");

    // A rule can be switched off.
    const daily = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Daily lead cap" }) });
    await daily.getByLabel("In use").uncheck();
    await daily.getByRole("button", { name: "Save", exact: true }).click();
    await expect(daily).toContainText("Switched off");
    await daily.getByLabel("In use").check();
    await daily.getByRole("button", { name: "Save", exact: true }).click();
    await expect(daily).toContainText("In use");

    await expectNoViolations(page, "routing page (owner)");

    // Put the setting back for the next run.
    await hours.getByLabel("Stop this many minutes before closing").fill("15");
    await hours.getByRole("button", { name: "Save", exact: true }).click();
    await expect(hours.getByLabel("Stop this many minutes before closing")).toHaveValue("15");

    // Staff: read-only.
    await signInAs(page);
    await page.goto("/admin/routing");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Apply .* (earlier|later)/ })).toHaveCount(0);
    await expect(page.getByText(/stop this many minutes before closing: 15/)).toBeVisible();
    await expectNoViolations(page, "routing page (staff)");
  });

  test("a stale edit is refused instead of overwriting someone else's change", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/admin/routing");
    const hours = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: "Working hours" }) });
    await hours.getByLabel("Stop this many minutes before closing").fill("20");
    // Somebody else saves first (the version moves on) while this page is still open.
    await withDb(async (client) => {
      await client.query("update routing_rules set version = version + 1 where type = 'working_hours'");
    });
    await hours.getByRole("button", { name: "Save", exact: true }).click();
    await expect(problem(page)).toContainText("Someone else changed that");
    await expect(hours.getByLabel("Stop this many minutes before closing")).not.toHaveValue("20");
  });
});

test.describe("a business's own preferences", () => {
  test("priority, weight and caps are validated and saved; weight 0 keeps it out of automatic routing", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    const name = await createActiveClient(page, `E2E Route Prefs ${unique()}`);
    const section = page.locator("#routing");
    await expect(section.getByLabel("Priority")).toHaveValue("100");
    await expect(section.getByLabel("Weight")).toHaveValue("1");

    await setPrefs(page, { priority: "9999", weight: "x" });
    await expect(problem(page)).toContainText("whole number from 0 to 1000");
    await setPrefs(page, { priority: "10", weight: "2", daily: "5", monthly: "2" });
    await expect(problem(page)).toContainText("monthly limit cannot be lower than the daily limit");
    await setPrefs(page, { priority: "10", weight: "2", daily: "5", monthly: "60" });
    await expect(page.getByRole("status").first()).toContainText("Routing preferences saved");
    await expect(section.getByLabel("Weight")).toHaveValue("2");
    await expect(section.getByLabel("Most leads a day")).toHaveValue("5");

    // Manual only: the dry run for a lead shows it as not eligible, with the reason.
    await setPrefs(page, { weight: "0" });
    await expect(page.getByRole("status").first()).toContainText("Routing preferences saved");
    const reference = await createLead(request, baseURL!, uniquePerson("Manual"), "new");
    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await page.locator("#routing").getByRole("link", { name: /Who would get this lead/ }).click();
    await expect(page.locator("#routing").getByRole("row").filter({ hasText: name })).toContainText("manual only");
  });

  test("working hours: a restriction needs a real open day; unticking removes it", async ({ page }) => {
    await signInAsOwner(page);
    await createActiveClient(page, `E2E Route Hours ${unique()}`);
    const section = page.locator("#routing");

    await section.getByLabel("Only send leads during working hours").check();
    await section.getByRole("button", { name: "Save working hours" }).click();
    await expect(problem(page)).toContainText("Choose at least one open day");

    await section.getByLabel("Only send leads during working hours").check();
    await section.getByLabel("Monday opens").fill("08:00");
    await section.getByRole("button", { name: "Save working hours" }).click();
    await expect(problem(page)).toContainText("Monday: enter both an opening and a closing time");

    await section.getByLabel("Only send leads during working hours").check();
    await section.getByLabel("Monday opens").fill("08:00");
    await section.getByLabel("Monday closes").fill("17:30");
    await section.getByLabel("Friday opens").fill("09:00");
    await section.getByLabel("Friday closes").fill("12:00");
    await section.getByRole("button", { name: "Save working hours" }).click();
    await expect(page.getByRole("status").first()).toContainText("Working hours saved");
    await expect(section.getByLabel("Only send leads during working hours")).toBeChecked();
    await expect(section.getByLabel("Monday closes")).toHaveValue("17:30");
    await expect(section.getByLabel("Tuesday opens")).toHaveValue("");

    await section.getByLabel("Only send leads during working hours").uncheck();
    await section.getByRole("button", { name: "Save working hours" }).click();
    await expect(page.getByRole("status").first()).toContainText("Working hours saved");
    await expect(section.getByLabel("Only send leads during working hours")).not.toBeChecked();
    await expect(section.getByLabel("Monday opens")).toHaveValue("");
  });

  test("a pause can be added and removed, and is shown in the business's own time", async ({ page }) => {
    await signInAsOwner(page);
    await createActiveClient(page, `E2E Route Pause ${unique()}`);
    const section = page.locator("#routing");

    await section.getByRole("button", { name: "Add pause" }).click();
    await expect(problem(page)).toContainText("Enter the date and time the pause starts");

    await section.getByLabel("From").fill("2027-03-01T09:00");
    await section.getByLabel("Until").fill("2027-03-08T09:00");
    await section.getByLabel("Why").selectOption("holiday");
    await section.getByRole("button", { name: "Add pause" }).click();
    await expect(page.getByRole("status").first()).toContainText("Pause added");
    const item = section.getByRole("listitem").filter({ hasText: "Upcoming" });
    await expect(item).toContainText("1 Mar, 09:00 to 8 Mar, 09:00");
    await expect(item).toContainText("Holiday or time away");
    await expectNoViolations(page, "client page with routing preferences");

    await item.getByRole("button", { name: /Remove the pause/ }).click();
    await expect(page.getByRole("status").first()).toContainText("Pause removed");
    await expect(section.getByText("No pauses.")).toBeVisible();
  });
});
