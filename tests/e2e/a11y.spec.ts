import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fillContact, seedProgress, startForm, uniquePerson } from "./helpers";

async function expectNoViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

test.describe("accessibility (WCAG 2.2 AA via axe)", () => {
  test("landing page", async ({ page }) => {
    await startForm(page);
    await expectNoViolations(page, "landing");
  });

  test("landing page shows where we cover on a real map, numbered, with the same information as text", async ({ page }) => {
    await page.goto("/");
    const section = page.getByRole("region", { name: /Local roofers across/ });
    await expect(section.getByRole("region", { name: /Map of the areas we cover/ })).toBeVisible();
    await expect(section.getByRole("link", { name: /OpenStreetMap contributors/ })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    const list = section.getByRole("list", { name: "The areas on the map" });
    await expect(list.getByRole("listitem")).toHaveCount(13);
    await expect(list.getByText("Bexleyheath", { exact: true })).toBeVisible();
    await expect(list.getByText("DA6, DA7")).toBeVisible();
    await expect(list.getByText("Sidcup", { exact: true })).toBeVisible();
    await expect(list.getByText("SE9")).toBeVisible();
    // The map is our own file: the page never asks a map provider for anything.
    const foreign = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => new URL(entry.name).origin).filter((origin) => origin !== location.origin && !origin.includes("challenges.cloudflare.com")));
    expect(foreign).toEqual([]);
  });

  const steps: Array<[number, string, Record<string, unknown>]> = [
    [1, "Where is the work needed?", { postcode: "", coverage: null }],
    [2, "Tell us about the property", { propertyType: null, ownership: null }],
    [3, "Which best describes the work?", { scope: null }],
    [4, "When would you like the work done?", { urgency: null }],
    [5, "How can the roofer contact you?", {}],
  ];

  for (const [step, heading, values] of steps) {
    test(`step ${step + 1}: ${heading}`, async ({ page }) => {
      await seedProgress(page, step, values);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectNoViolations(page, heading);
    });
  }

  test("contact step in its error state", async ({ page }) => {
    await seedProgress(page, 5);
    await page.getByRole("button", { name: "Get my free quote" }).click({ trial: false, timeout: 15_000 });
    await expect(page.getByRole("alert").filter({ hasText: "There is a problem" })).toBeVisible();
    await expectNoViolations(page, "contact errors");
  });

  test("contact step with the optional notes field open", async ({ page }) => {
    await seedProgress(page, 5);
    await page.getByRole("button", { name: "Add more details (optional)" }).click();
    await expect(page.getByLabel(/Anything else the roofer should know/)).toBeVisible();
    await fillContact(page, uniquePerson("A11y"));
    await expectNoViolations(page, "contact with notes");
  });

  test("confirmation screen's neighbours: privacy notice and terms", async ({ page }) => {
    for (const path of ["/privacy", "/terms"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoViolations(page, path);
    }
  });
});
