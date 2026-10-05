import { expect, test, type Page } from "@playwright/test";
import { createLead, signInAs, signInAsOwner } from "./api";
import { createActiveClient, deliverNow, expectNoViolations, problem, unique } from "./flows";
import { uniquePerson, withDb } from "./helpers";

/**
 * Delivery to businesses (stage 5) in a real browser, against the production build: how a business is set up to be told (and the webhook
 * signing secret that is shown once), a lead that goes out automatically and says so, a failed channel that lands in the queue and can
 * be retried, and a lead whose every way failed that comes back to the operator. The worker's pass runs in this process (`deliverNow`)
 * with stand-in providers; the real worker, real HTTP adapters and a killed worker are proved in tests/integration/worker-process.test.ts.
 */
const delivery = (page: Page) => page.locator("#delivery");
const saveDelivery = (page: Page) => delivery(page).getByRole("button", { name: "Save how they are told" }).click();

/** Makes sure roof repair, urgent leads have a price, so assigning by hand does not ask for one (the most specific rule wins over any other). */
async function priceForTestLeads(page: Page) {
  await page.goto("/admin/pricing");
  await page.getByLabel("Service", { exact: true }).selectOption("roof_repair");
  await page.getByLabel("Urgency").selectOption("emergency");
  await page.getByLabel("Price per lead (£)").fill("35");
  await page.getByRole("button", { name: "Save price" }).click();
  await expect(page.getByRole("status")).toContainText("Price saved");
}

async function assignTo(page: Page, request: Parameters<typeof createLead>[0], baseURL: string, businessName: string): Promise<string> {
  const reference = await createLead(request, baseURL, uniquePerson("Deliver"), "new");
  await page.goto("/admin/leads");
  await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
  await page.locator("#assign-client").selectOption({ label: `${businessName} (covers this postcode)` });
  await page.getByRole("button", { name: "Assign lead" }).click();
  await expect(page.getByRole("status").first()).toContainText("Lead assigned");
  return reference;
}

test.describe("setting up how a business is told", () => {
  test("validated, saved, audited; the signing secret is shown once and never again", async ({ page }) => {
    await signInAsOwner(page);
    await createActiveClient(page, `E2E Deliver Setup ${unique()}`);
    const section = delivery(page);
    await expect(section.getByLabel("Delivery", { exact: true })).toHaveValue("manual");

    // Automatic needs at least one way.
    await section.getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await section.getByRole("checkbox", { name: /^Email/ }).uncheck();
    await saveDelivery(page);
    await expect(problem(page)).toContainText("Choose at least one way to tell them");

    // A webhook needs an https address, and a secret first.
    await section.getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await section.getByRole("checkbox", { name: /^Webhook/ }).check();
    await saveDelivery(page);
    await expect(problem(page)).toContainText("Enter the webhook address");
    await section.getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await section.getByRole("checkbox", { name: /^Webhook/ }).check();
    await section.getByLabel("Webhook address").fill("http://crm.example.com/hook");
    await saveDelivery(page);
    await expect(problem(page)).toContainText("https://");
    await section.getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await section.getByRole("checkbox", { name: /^Webhook/ }).check();
    await section.getByLabel("Webhook address").fill("https://crm.example.com/hook");
    await saveDelivery(page);
    await expect(problem(page)).toContainText("Generate a signing secret before turning on the webhook");

    // The secret appears once, in the page it was asked for, and is not in the URL.
    await section.getByRole("button", { name: "Generate a signing secret" }).click();
    const secret = section.getByLabel("New webhook signing secret");
    await expect(secret).toHaveValue(/^whsec_[A-Za-z0-9_-]{43}$/);
    await expect(section.getByText("It will not be shown again")).toBeVisible();
    const shown = await secret.inputValue();
    expect(page.url()).not.toContain(shown);

    await page.reload();
    await expect(delivery(page).getByLabel("New webhook signing secret")).toHaveCount(0);
    await expect(delivery(page).getByText(`A secret is set (ending ${shown.slice(-4)})`)).toBeVisible();
    expect(await page.content()).not.toContain(shown);

    // Now it can be saved: automatic, email + text + webhook.
    await section.getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await section.getByRole("checkbox", { name: /^Email/ }).check();
    await section.getByRole("checkbox", { name: /^Text message/ }).check();
    await section.getByRole("checkbox", { name: /^Webhook/ }).check();
    await section.getByLabel("Webhook address").fill("https://crm.example.com/hook");
    await saveDelivery(page);
    await expect(page.getByRole("status").first()).toContainText("Saved how they are told");
    await expect(delivery(page).getByText(/Automatic since/)).toBeVisible();
    await expectNoViolations(page, "client page with delivery settings");

    // The database never holds the secret in the clear.
    const stored = await withDb(async (client) => (await client.query("select webhook_secret_enc from clients where webhook_secret_hint = $1 order by updated_at desc limit 1", [shown.slice(-4)])).rows[0]?.webhook_secret_enc as string);
    expect(stored).toMatch(/^v1\./);
    expect(stored).not.toContain(shown.slice(8, 24));
  });
});

test.describe("a lead delivered automatically", () => {
  test("goes out on every channel, the lead page says so, and it needs nobody", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    await priceForTestLeads(page);
    const name = await createActiveClient(page, `E2E Deliver Auto ${unique()}`);
    await delivery(page).getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await delivery(page).getByRole("checkbox", { name: /^Text message/ }).check();
    await saveDelivery(page);
    await expect(page.getByRole("status").first()).toContainText("Saved how they are told");

    const reference = await assignTo(page, request, baseURL!, name);
    expect(await deliverNow()).toMatchObject({ email: 1, sms: 1 });

    await page.reload();
    const sent = page.locator("#delivery");
    await expect(sent).toContainText("Sent automatically");
    await expect(sent.getByRole("listitem").filter({ hasText: "Email" })).toContainText("Sent");
    await expect(sent.getByRole("listitem").filter({ hasText: "Text message" })).toContainText("Sent");
    await expect(page.getByText("Assigned: send it")).toHaveCount(0); // it has been sent: nothing for a person to do
    await expectNoViolations(page, "lead page with automatic delivery");

    await page.goto("/admin/leads");
    await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(0); // out of Needs action
  });

  test("a failed channel is queued with the reason, can be retried, and the lead is told once it works", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    await priceForTestLeads(page);
    const name = await createActiveClient(page, `E2E Deliver Retry ${unique()}`);
    await delivery(page).getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await delivery(page).getByRole("checkbox", { name: /^Text message/ }).check();
    await saveDelivery(page);
    const reference = await assignTo(page, request, baseURL!, name);
    await deliverNow({ smsFails: true });

    // The email went out (so the lead is "sent"), the text failed: nobody has confirmed they were reached.
    await page.reload();
    await expect(page.locator("#delivery").getByRole("listitem").filter({ hasText: "Text message" })).toContainText("Failed");
    await page.goto("/admin/deliveries");
    const row = page.getByRole("row").filter({ hasText: reference });
    await expect(row).toContainText("That is not a valid mobile number");
    await expect(row).toContainText("Text message");
    await expectNoViolations(page, "deliveries queue");

    await row.getByRole("button", { name: /Try again/ }).click();
    await expect(page.getByRole("status").first()).toContainText("Back in the queue");
    await deliverNow();
    await page.goto("/admin/deliveries");
    await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(0);
  });

  test("when every way fails the lead comes back to the operator, with the reason", async ({ page, request, baseURL }) => {
    await signInAsOwner(page);
    await priceForTestLeads(page);
    const name = await createActiveClient(page, `E2E Deliver Fail ${unique()}`);
    await delivery(page).getByLabel("Delivery", { exact: true }).selectOption("automatic");
    await delivery(page).getByRole("checkbox", { name: /^Email/ }).uncheck();
    await delivery(page).getByRole("checkbox", { name: /^Text message/ }).check();
    await saveDelivery(page);
    const reference = await assignTo(page, request, baseURL!, name);
    await deliverNow({ smsFails: true });

    await page.goto("/admin/leads");
    const row = page.getByRole("row").filter({ hasText: reference });
    await expect(row).toContainText("Needs action");
    await row.getByRole("link", { name: reference }).click();
    await expect(page.getByText(/Delivery to the business failed on every way/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Hand this lead to a business" })).toBeVisible();
  });

  test("staff can look at and retry deliveries too", async ({ page }) => {
    await signInAs(page);
    await page.goto("/admin/deliveries");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Deliveries that need you");
    await expectNoViolations(page, "deliveries queue (staff)");
  });
});
