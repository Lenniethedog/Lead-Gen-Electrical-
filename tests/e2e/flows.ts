import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import pino from "pino";
import { DEV_PRIVACY_HASH_KEY } from "../../src/config/privacy";
import { createDb } from "../../src/lib/db/client";
import { createPrivacyService } from "../../src/modules/privacy";
import { createDeliveryService, type SendResult } from "../../src/modules/delivery";
import { createRoutingService } from "../../src/modules/routing";
import { createLead } from "./api";
import { SERVICE, uniquePerson } from "./helpers";

/** Steps shared by the browser tests: things an operator does that take several clicks, and the accessibility check. */

export const unique = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

/** The page's own error message. (Next.js adds a route announcer that is also role="alert" and would make this ambiguous.) */
export const problem = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

export async function expectNoViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

/** Creates a client through the real form, gives it a service and a BR6 coverage rule, and activates it. Returns its name. */
export async function createActiveClient(page: Page, name: string, outward = "BR6") {
  await page.goto("/admin/clients/new");
  await page.getByLabel("Business name").fill(name);
  await page.getByLabel("Their email").fill(`${name.toLowerCase().replace(/[^a-z0-9]/g, "")}@electrician.example`);
  await page.getByLabel("Who to send leads to").fill("Dave");
  await page.getByLabel(/Their phone/).fill("07911 123456");
  await page.getByRole("button", { name: "Create client" }).click();
  await expect(page.getByRole("status").first()).toContainText("Client created");

  await page.getByLabel(SERVICE).check();
  await page.getByRole("button", { name: "Save services" }).click();
  await expect(page.getByRole("status").first()).toContainText("Services saved");

  await page.getByLabel("A postcode district: District").fill(outward);
  await page.locator("form").filter({ has: page.getByLabel("A postcode district: District") }).getByRole("button", { name: "Add" }).click();
  await expect(page.getByRole("status").first()).toContainText("Coverage rule added");

  await page.getByLabel("Change to").selectOption("active");
  await page.getByRole("button", { name: "Change status" }).click();
  await expect(page.getByRole("status").first()).toContainText("Status changed");
  await expect(page.getByRole("heading", { level: 1 })).toContainText(name);
  return name;
}


/**
 * Runs the router once, in this process, against the same database the web server uses. The browser tests have no worker running (the
 * worker's NOTIFY wake-up is proved by the real-process integration tests); this does exactly what a worker's pass does.
 */
export async function routeNow(): Promise<{ routed: number; assigned: number; unroutable: number; skipped: number; errors: number }> {
  const db = createDb({ url: process.env.DATABASE_URL!, poolMax: 2 });
  try {
    const logger = pino({ level: "silent" });
    const privacy = createPrivacyService({ db, logger, hashKey: DEV_PRIVACY_HASH_KEY });
    const routing = createRoutingService({ db, logger, verticalSlug: "electrical", isSuppressed: privacy.isSuppressed });
    return await routing.drain();
  } finally {
    await db.destroy();
  }
}

/**
 * Runs the delivery worker's pass once, in this process, with stand-in providers: there is no worker in the browser tests, and no real
 * Twilio or business server to talk to. `smsFails` makes the text provider reject the number (as Twilio does for an invalid one).
 */
export async function deliverNow(options: { smsFails?: boolean } = {}): Promise<{ email: number; sms: number; webhook: number }> {
  const db = createDb({ url: process.env.DATABASE_URL!, poolMax: 2 });
  const calls = { email: 0, sms: 0, webhook: 0 };
  try {
    const accepted = (): SendResult => ({ outcome: "accepted", providerMessageId: `SM${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}` });
    const service = createDeliveryService({
      db,
      logger: pino({ level: "silent" }),
      senders: {
        email: { send: async () => ((calls.email += 1), accepted()) },
        sms: { send: async () => ((calls.sms += 1), options.smsFails ? { outcome: "permanent_failure", errorCode: "twilio_21211", httpStatus: 400 } : accepted()) },
        webhook: { send: async () => ((calls.webhook += 1), { outcome: "accepted" }) },
      },
      config: { brandName: "SparkQuote Local", leaseSeconds: 60, sendTimeoutMs: 2_000, batchSize: 5 },
    });
    for (let i = 0; i < 20 && (await service.processDue()).claimed > 0; i++);
    return calls;
  } finally {
    await db.destroy();
  }
}

/** Makes sure electrical fault repair, urgent leads have a price, so assigning by hand does not ask for one (the most specific rule wins over any other). */
export async function priceForTestLeads(page: Page) {
  await page.goto("/admin/pricing");
  await page.getByLabel("Service", { exact: true }).selectOption("fault_repair");
  await page.getByLabel("Urgency").selectOption("emergency");
  await page.getByLabel("Price per lead (£)").fill("35");
  await page.getByRole("button", { name: "Save price" }).click();
  await expect(page.getByRole("status")).toContainText("Price saved");
}

export async function assignTo(page: Page, request: Parameters<typeof createLead>[0], baseURL: string, businessName: string): Promise<string> {
  const reference = await createLead(request, baseURL, uniquePerson("Deliver"), "new");
  await page.goto("/admin/leads");
  await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
  await page.locator("#assign-client").selectOption({ label: `${businessName} (covers this postcode)` });
  await page.getByRole("button", { name: "Assign lead" }).click();
  await expect(page.getByRole("status").first()).toContainText("Lead assigned");
  return reference;
}


/**
 * A page must never be wider than the screen it is shown on. Measured against the DEVICE's width, not `innerWidth`: when a page overflows, a phone
 * widens its layout viewport and zooms out, so `innerWidth` would grow with the page and hide the problem. (A hidden "Actions" table heading
 * once did exactly that: sr-only text is absolutely positioned and escaped an unpositioned scroll wrapper.)
 */
export async function expectFitsScreen(page: Page, label: string) {
  const device = page.viewportSize()?.width;
  if (device === undefined) throw new Error("the page has no viewport size");
  const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
  expect(widths.document, `${label}: the page is wider than the ${device}px screen (document ${widths.document}px, body ${widths.body}px)`).toBeLessThanOrEqual(device);
}
