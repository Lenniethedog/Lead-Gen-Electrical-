import { expect, test } from "@playwright/test";
import { chooseTile, fillContact, submitEnquiry, uniquePerson, withDb } from "./helpers";

/** What is particular to the electrical site: the trade's words everywhere, and the emergency advice before anything else. */

test.describe("electrical site", () => {
  test("talks about electricians and electrical work, never roofs, and puts the emergency advice before the form", async ({ page, isMobile }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Free electrician quotes from local electricians");
    await expect(page.getByRole("heading", { name: "What electrical work do you need?" })).toBeVisible();

    const safety = page.getByRole("complementary", { name: "Electrical safety" });
    await expect(safety).toContainText("Sparks, a burning smell or an electric shock? Don't wait for a quote: call 999");
    await expect(safety.getByRole("link", { name: "999" })).toHaveAttribute("href", "tel:999");
    await expect(safety.getByRole("link", { name: "105" })).toHaveAttribute("href", "tel:105");
    // Seen on arrival: on a phone above the form, on a wider screen beside it.
    await expect(safety).toBeInViewport();
    if (isMobile) {
      const [noteBox, formBox] = await Promise.all([safety.boundingBox(), page.locator("#quote").boundingBox()]);
      expect(noteBox!.y).toBeLessThan(formBox!.y);
    }

    await expect(page.getByRole("heading", { name: "Electrical work we can help you find an electrician for" })).toBeVisible();
    for (const label of ["Fuse box / consumer unit", "Rewire", "Electrical safety check (EICR)", "EV charger installation"]) {
      await expect(page.getByRole("heading", { level: 3, name: label })).toBeVisible();
    }
    await expect(page.getByText("How do I check an electrician is qualified?")).toBeVisible();
    await expect(page.getByText("We are not an electrical company and do not carry out electrical work.")).toBeVisible();
    await expect(page).toHaveTitle(/^Free electrician quotes in /);
    expect((await page.locator("body").innerText()).replace(/proof/gi, "")).not.toMatch(/roof/i);
  });

  test("on a phone, the safety line AND the first question are on the first screen, without scrolling", async ({ page, isMobile }) => {
    test.skip(!isMobile, "the first-screen rule is about phones (paid traffic is mostly phones)");
    await page.goto("/");
    await expect(page.getByRole("complementary", { name: "Electrical safety" })).toBeInViewport();
    await expect(page.getByRole("heading", { name: "What electrical work do you need?" })).toBeInViewport();
    await expect(page.getByRole("radiogroup").getByText("Electrical fault or repair", { exact: true })).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test("an urgent fault: the full safety advice is on the 'when' question, and the lead is stored as a fault repair", async ({ page }) => {
    const person = uniquePerson("Fault");
    await page.goto("/");
    await chooseTile(page, "Electrical fault or repair");
    await expect(page.getByText("We only pass your details to electricians who cover this postcode.")).toBeVisible();
    await page.getByLabel("Property postcode").fill("br6 0aa");
    await expect(page.getByText(/Good news: we cover Orpington/)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await chooseTile(page, "Flat or maisonette");
    await chooseTile(page, "I rent the property");
    await page.getByRole("button", { name: "Continue" }).click();
    await chooseTile(page, "Part or all of the property has no power");

    await expect(page.getByRole("heading", { name: "When would you like the work done?" })).toBeVisible();
    const note = page.locator("#quote").getByRole("complementary", { name: "Electrical safety" });
    await expect(note).toBeVisible();
    await expect(note).toContainText("Power cut or a fallen cable?");
    await expect(page.getByRole("radiogroup").getByText("There's no power, or it feels unsafe right now")).toBeVisible();
    await chooseTile(page, "Urgent");

    await expect(page.getByRole("heading", { name: "How can the electrician contact you?" })).toBeVisible();
    await expect(page.getByText(/one local electrical business that covers my area/)).toBeVisible();
    await fillContact(page, person);
    await page.waitForTimeout(10_500); // human pace, or the timing signal would (rightly) hold it for review
    await submitEnquiry(page);
    await expect(page.getByRole("heading", { name: "Thanks, your enquiry has been sent" })).toBeVisible();
    await expect(page.getByText(/passing your details to a local electrical business/)).toBeVisible();

    const stored = await withDb(async (client) =>
      (
        await client.query(
          `select l.status, s.slug as service, l.urgency, l.details->>'scope' as scope, ct.body like '%one local electrical business%' as electrical_consent
             from leads l
             join lead_contacts c on c.lead_id = l.id
             join service_types s on s.id = l.service_type_id
             join consent_records cr on cr.lead_id = l.id
             join consent_texts ct on ct.id = cr.consent_text_id
            where c.email_normalised = $1`,
          [person.email.toLowerCase()],
        )
      ).rows,
    );
    expect(stored).toEqual([{ status: "new", service: "fault_repair", urgency: "emergency", scope: "no_power", electrical_consent: true }]);
  });

  test("an EV charger is its own choice, with its own follow-up question", async ({ page }) => {
    await page.goto("/");
    await chooseTile(page, "EV charger installation");
    await page.getByLabel("Property postcode").fill("TN13 1AA");
    await expect(page.getByText(/Good news: we cover/)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await chooseTile(page, "House");
    await chooseTile(page, "I own the property");
    await page.getByRole("button", { name: "Continue" }).click();
    for (const scope of ["A charger at my house", "A charger at a flat or shared parking", "Chargers for a business or workplace"]) {
      await expect(page.getByRole("radiogroup").getByText(scope, { exact: true })).toBeVisible();
    }
  });

  test("the legal pages talk about electrical businesses and how to check an electrician", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByText(/when you ask for electrician quotes/)).toBeVisible();
    await expect(page.getByText("One local electrical business", { exact: true })).toBeVisible();
    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: "Electrical businesses" })).toBeVisible();
    await expect(page.getByText(/registered with a competent person scheme/)).toBeVisible();
    expect((await page.locator("main").innerText()).replace(/proof/gi, "")).not.toMatch(/roof/i);
  });
});
