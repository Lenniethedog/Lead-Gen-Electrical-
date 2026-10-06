import { test } from "@playwright/test";
import { signInAsOwner } from "./api";
import { createActiveClient, expectFitsScreen, priceForTestLeads, unique } from "./flows";

/**
 * Nothing may be wider than a phone screen. This runs on the phone project only (a desktop window has nothing to overflow): every public page and every
 * admin page, with data on them (tables with rows are what push a page wider), measured against the device's real width.
 */
test.describe("fits a phone screen", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "a phone-width check");
  });

  test("the public pages", async ({ page }) => {
    for (const path of ["/", "/privacy", "/terms", "/dashboard/login"]) {
      await page.goto(path);
      await expectFitsScreen(page, path);
    }
  });

  test("every admin page, with prices, a client and its billing on them", async ({ page }) => {
    await signInAsOwner(page);
    await priceForTestLeads(page); // a price exists: the pricing table has rows
    await createActiveClient(page, `E2E Layout ${unique()}`);
    const clientPage = page.url();
    for (const path of ["/admin/leads", "/admin/clients", "/admin/pricing", "/admin/coverage", "/admin/routing", "/admin/deliveries", "/admin/disputes", clientPage]) {
      await page.goto(path);
      await expectFitsScreen(page, path);
    }
  });
});
