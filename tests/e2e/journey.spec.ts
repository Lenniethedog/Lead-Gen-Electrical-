import { expect, test } from "@playwright/test";
import { chooseTile, fillContact, leadsFor, seedProgress, SERVICE, startForm, submitEnquiry, uniquePerson } from "./helpers";

test.describe("consumer journey", () => {
  test("a visitor completes all six steps and gets a reference; exactly one lead is stored", async ({ page }) => {
    const person = uniquePerson("Journey");
    await startForm(page);

    // 1. Service: tapping a tile moves on by itself.
    await chooseTile(page, SERVICE);
    await expect(page.getByRole("heading", { name: "Where is the work needed?" })).toBeVisible();

    // 2. Postcode: coverage is confirmed by the server before Continue.
    await page.getByLabel("Property postcode").fill("br6 0aa");
    await expect(page.getByText("Good news: we cover Orpington (BR6 0AA).")).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();

    // 3. Property: two questions, explicit Continue.
    await expect(page.getByRole("heading", { name: "Tell us about the property" })).toBeVisible();
    await chooseTile(page, "House");
    await chooseTile(page, "I own the property");
    await page.getByRole("button", { name: "Continue" }).click();

    // 4. Scope depends on the service chosen in step 1.
    await expect(page.getByRole("heading", { name: "Which best describes the work?" })).toBeVisible();
    await chooseTile(page, "The roof is leaking");

    // 5. Urgency.
    await expect(page.getByRole("heading", { name: "When would you like the work done?" })).toBeVisible();
    await chooseTile(page, "Within 2 weeks");

    // 6. Contact + consent.
    await expect(page.getByRole("heading", { name: "How can the roofer contact you?" })).toBeVisible();
    await fillContact(page, person);
    // Playwright is faster than any human. Under 10s the anti-bot timing signal would (correctly) hold
    // this lead for review, so pace the run like a person; the machine-speed case has its own test below.
    await page.waitForTimeout(10_500);
    const response = page.waitForResponse((r) => r.url().endsWith("/api/v1/leads") && r.request().method() === "POST");
    await submitEnquiry(page);

    const result = await response;
    expect(result.status()).toBe(201);
    const { data } = (await result.json()) as { data: { reference: string } };

    await expect(page.getByRole("heading", { name: "Thanks, your enquiry has been sent" })).toBeVisible();
    await expect(page.getByText(data.reference)).toBeVisible();

    // The progress that held the visitor's personal data is gone from the tab.
    expect(await page.evaluate(() => sessionStorage.getItem("leadform.v1"))).toBeNull();

    const stored = await leadsFor(person.email);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("new");
    expect(stored[0]?.reference).toBe(data.reference);
  });

  test("a machine-speed submission looks successful to the sender but is held for review, not routed", async ({ page }) => {
    const person = uniquePerson("Robot");
    await seedProgress(page, 5, {}, { elapsedMs: 1_500 });
    await fillContact(page, person);
    await submitEnquiry(page);
    // Nothing tells the sender how we screen.
    await expect(page.getByRole("heading", { name: "Thanks, your enquiry has been sent" })).toBeVisible();
    const stored = await leadsFor(person.email);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.status).toBe("held");
  });

  test("keeps their answers across a reload, and Back works", async ({ page }) => {
    await startForm(page);
    await chooseTile(page, SERVICE);
    await page.getByLabel("Property postcode").fill("BR6 0AA");
    await expect(page.getByText(/we cover Orpington/)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Tell us about the property" })).toBeVisible();

    await page.waitForTimeout(500); // progress is saved on a short debounce
    await page.reload();
    await expect(page.getByRole("heading", { name: "Tell us about the property" })).toBeVisible();

    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByLabel("Property postcode")).toHaveValue("BR6 0AA");
  });

  test("tells someone outside the footprint straight away and does not let them continue", async ({ page }) => {
    await startForm(page);
    await chooseTile(page, SERVICE);
    await page.getByLabel("Property postcode").fill("SW1A 1AA");
    await expect(page.getByText(/Sorry, we don't cover SW1A 1AA yet\. We currently cover South East London/).first()).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Where is the work needed?" })).toBeVisible();
  });

  test("rejects a malformed postcode with a helpful message", async ({ page }) => {
    await startForm(page);
    await chooseTile(page, SERVICE);
    await page.getByLabel("Property postcode").fill("hello");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Enter a valid UK postcode, like BR6 0AA")).toBeVisible();
  });

  test("keyboard users are never moved on unexpectedly: they choose, then press Continue", async ({ page, isMobile }) => {
    test.skip(isMobile, "keyboard navigation is a desktop concern");
    await startForm(page);
    const radio = page.getByRole("radio", { name: /Roof repair or leak/ });
    await radio.focus();
    await page.keyboard.press("Space");
    await expect(radio).toBeChecked();
    await page.waitForTimeout(700);
    await expect(page.getByRole("heading", { name: "What roofing work do you need?" })).toBeVisible();

    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Where is the work needed?" })).toBeVisible();
    // Focus lands on the new question's heading so a screen reader announces it.
    await expect(page.getByRole("heading", { name: "Where is the work needed?" })).toBeFocused();
  });

  test("shows an error summary, then accepts corrected details", async ({ page }) => {
    const person = uniquePerson("Errors");
    await seedProgress(page, 5);
    await submitEnquiry(page);

    const summary = page.getByRole("alert").filter({ hasText: "There is a problem" });
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    await expect(summary.getByRole("link", { name: "Enter your phone number" })).toBeVisible();
    await expect(page.getByText("You need to agree before we can pass on your details").first()).toBeVisible();

    await page.getByLabel("Phone number").fill("12345");
    await page.getByLabel("Phone number").blur();
    await expect(page.getByText(/Enter a valid UK phone number, like 07123 456789/).first()).toBeVisible();

    await fillContact(page, person);
    await submitEnquiry(page);
    await expect(page.getByRole("heading", { name: "Thanks, your enquiry has been sent" })).toBeVisible();
  });
});

test.describe("resilience", () => {
  test("a double-click sends ONE request and creates ONE lead", async ({ page }) => {
    const person = uniquePerson("Double");
    let posts = 0;
    await page.route("**/api/v1/leads", async (route) => {
      posts += 1;
      await route.continue();
    });
    await seedProgress(page, 5);
    await fillContact(page, person);
    const button = page.getByRole("button", { name: "Get my free quote" });
    await expect(button).toBeEnabled({ timeout: 15_000 });
    await button.dblclick();

    await expect(page.getByRole("heading", { name: "Thanks, your enquiry has been sent" })).toBeVisible();
    expect(posts).toBe(1);
    expect(await leadsFor(person.email)).toHaveLength(1);
  });

  test("survives a dropped connection: the retry reuses the idempotency key and still yields one lead", async ({ page }) => {
    const person = uniquePerson("Flaky");
    const keys: string[] = [];
    let attempts = 0;
    await page.route("**/api/v1/leads", async (route) => {
      attempts += 1;
      keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (attempts === 1) {
        // The server may or may not have seen this one; the client cannot know. Abort the socket.
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });
    await seedProgress(page, 5);
    await fillContact(page, person);
    await submitEnquiry(page);

    await expect(page.getByRole("heading", { name: "Thanks, your enquiry has been sent" })).toBeVisible({ timeout: 20_000 });
    expect(attempts).toBe(2);
    expect(new Set(keys).size).toBe(1);
    expect(await leadsFor(person.email)).toHaveLength(1);
  });

  test("a server-side validation error takes them to the field, with their answers intact", async ({ page }) => {
    const person = uniquePerson("Serverside");
    await page.route("**/api/v1/leads", async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "validation_failed", message: "x", fields: { "contact.phone": "Enter a valid UK phone number, like 07123 456789" }, requestId: "req-e2e" },
        }),
      });
    });
    await seedProgress(page, 5);
    await fillContact(page, person);
    await submitEnquiry(page);

    await expect(page.getByRole("alert").filter({ hasText: "There is a problem" })).toBeVisible();
    await expect(page.getByLabel("Name", { exact: false }).first()).toHaveValue(person.name);
    await expect(page.getByLabel("Phone number")).toHaveAttribute("aria-invalid", "true");
  });

  test("shows a calm, honest message when the server is down, and keeps the answers", async ({ page }) => {
    const person = uniquePerson("Down");
    await page.route("**/api/v1/leads", (route) => route.abort("connectionrefused"));
    await seedProgress(page, 5);
    await fillContact(page, person);
    await submitEnquiry(page);
    await expect(page.getByText(/We couldn't reach our servers\. Your answers are saved/)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel("Your name")).toHaveValue(person.name);
    await expect(page.getByRole("button", { name: "Get my free quote" })).toBeEnabled();
  });

  test("continues past the postcode step if the coverage check is unavailable", async ({ page }) => {
    await page.route("**/api/v1/postcodes/check", (route) => route.abort("connectionrefused"));
    await startForm(page);
    await chooseTile(page, SERVICE);
    await page.getByLabel("Property postcode").fill("BR6 0AA");
    await expect(page.getByText(/couldn't check coverage just now/)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Tell us about the property" })).toBeVisible();
  });
});
