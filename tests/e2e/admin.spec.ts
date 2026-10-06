import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ACCESS, accessToken } from "./access";
import { createLead, e164, signInAs } from "./api";
import { uniquePerson, withDb } from "./helpers";

/**
 * The operator inbox in a real browser, against the production build, with REAL token verification:
 * a mock Cloudflare Access key server signs tokens the app accepts or (on purpose) refuses.
 * Runs on the phone and desktop projects: the operator will often open an alert on a phone.
 */
async function expectNoViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

test.describe("the inbox is closed to everyone without a valid Cloudflare Access token", () => {
  test("no token: 403, uncacheable, and the public site still works", async ({ request, baseURL }) => {
    for (const path of ["/admin", "/admin/leads", "/admin/leads/00000000-0000-4000-8000-000000000000"]) {
      const response = await request.get(`${baseURL}${path}`);
      expect(response.status(), `${path} answered ${response.status()}: is the web server running with the Access test settings?`).toBe(403);
      expect(response.headers()["cache-control"]).toContain("no-store");
      expect(await response.text()).toBe("Forbidden");
    }
    expect((await request.get(`${baseURL}/api/health`)).status()).toBe(200);
    expect((await request.get(`${baseURL}/`)).status()).toBe(200);
  });

  test("a POST to the admin (where server actions are served) is refused the same way", async ({ request, baseURL }) => {
    const response = await request.post(`${baseURL}/admin/leads`, { headers: { "next-action": "00".repeat(20), origin: baseURL! }, data: "[]" });
    expect(response.status()).toBe(403);
  });

  for (const [label, options] of [
    ["a token for a different Access application (wrong audience)", { audience: "b".repeat(64) }],
    ["a token from a different team (wrong issuer)", { issuer: "https://attacker.cloudflareaccess.com" }],
    ["an expired token", { expiresIn: -3_600 }],
    ["a valid token for someone who is not on the allowlist", { email: E2E_ACCESS.stranger }],
  ] as const) {
    test(`refuses ${label}`, async ({ request, baseURL }) => {
      const response = await request.get(`${baseURL}/admin/leads`, { headers: { [E2E_ACCESS.header]: await accessToken(options) } });
      expect(response.status()).toBe(403);
    });
  }

  test("refuses a forged token and a made-up header", async ({ request, baseURL }) => {
    for (const value of ["not.a.jwt", "x".repeat(200), "Bearer abc"]) {
      expect((await request.get(`${baseURL}/admin/leads`, { headers: { [E2E_ACCESS.header]: value } })).status()).toBe(403);
    }
    // Headers an attacker might hope switch the dev bypass on or impersonate Access.
    const response = await request.get(`${baseURL}/admin/leads`, { headers: { "x-admin-dev": "1", "cf-access-authenticated-user-email": E2E_ACCESS.operator } });
    expect(response.status()).toBe(403);
  });
});

test.describe("working the inbox", () => {
  test("a new lead appears with NO personal data in the list, and its page shows the contact details", async ({ page, request, baseURL }) => {
    const person = uniquePerson("Inbox");
    const reference = await createLead(request, baseURL!, person, "new");
    await signInAs(page);

    await page.goto("/admin/leads");
    await expect(page.getByRole("heading", { level: 1, name: "Leads" })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: reference });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Electrical fault or repair");
    await expect(row).toContainText("BR6");
    await expect(row).toContainText("Urgent");
    await expect(row).toContainText("Needs action");

    // The list must never carry contact details.
    const listText = await page.locator("main").innerText();
    for (const secret of [person.name, person.phone, e164(person.phone), person.email, "4821"]) expect(listText).not.toContain(secret);

    await row.getByRole("link", { name: reference }).click();
    await expect(page.getByRole("heading", { level: 1, name: reference })).toBeVisible();
    await expect(page.getByRole("link", { name: e164(person.phone) })).toHaveAttribute("href", `tel:${e164(person.phone)}`);
    await expect(page.getByRole("link", { name: person.email })).toHaveAttribute("href", `mailto:${person.email}`);
    await expect(page.getByText("Side gate code 4821")).toBeVisible(); // untrusted free text, rendered as text
    await expect(page.getByText(person.name, { exact: true })).toBeVisible();
    await expect(page.getByText("BR6 0AA")).toBeVisible();
  });

  test("approving a held lead records the operator and a reason, and the lead becomes a new lead", async ({ page, request, baseURL }) => {
    const person = uniquePerson("Approve");
    const reference = await createLead(request, baseURL!, person, "held");
    await signInAs(page);

    await page.goto("/admin/leads");
    const row = page.getByRole("row").filter({ hasText: reference });
    await expect(row).toContainText("Held for review");
    await row.getByRole("link", { name: reference }).click();

    await expect(page.getByRole("heading", { name: "Decide on this held lead" })).toBeVisible();
    await expect(page.getByText("turnstile_missing", { exact: true })).toBeVisible(); // why it was held
    await page.getByLabel(/Approve because/).selectOption("verified_contact");
    await page.getByRole("button", { name: "Approve lead" }).click();

    await expect(page.getByRole("status")).toContainText("Lead approved");
    await expect(page.getByRole("heading", { name: "Decide on this held lead" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Mark as handled" })).toBeVisible();

    const history = await withDb(async (client) =>
      (
        await client.query(
          `select h.from_status, h.to_status, h.actor_type, h.reason, o.email from lead_status_history h join leads l on l.id = h.lead_id
             left join operators o on o.id = h.actor_id where l.reference = $1 and h.actor_type = 'staff_user'`,
          [reference],
        )
      ).rows,
    );
    expect(history).toEqual([{ from_status: "held", to_status: "new", actor_type: "staff_user", reason: "verified_contact", email: E2E_ACCESS.operator }]);
    await expect(page.getByText(`Held lead approved (verified_contact)`)).toBeVisible();
  });

  test("rejecting a held lead removes it from 'Needs action' and shows it under 'Screened out'", async ({ page, request, baseURL }) => {
    const reference = await createLead(request, baseURL!, uniquePerson("Reject"), "held");
    await signInAs(page);
    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();

    await page.getByLabel(/Reject because/).selectOption("spam_or_bot");
    await page.getByRole("button", { name: "Reject lead" }).click();
    await expect(page.getByRole("status")).toContainText("Lead rejected");

    await page.getByRole("link", { name: /All leads/ }).click();
    await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(0);
    await page.getByRole("link", { name: "Screened out" }).click();
    await expect(page.getByRole("row").filter({ hasText: reference })).toContainText("Rejected");
  });

  test("a decision needs a reason: the form will not submit without one", async ({ page, request, baseURL }) => {
    const reference = await createLead(request, baseURL!, uniquePerson("Reason"), "held");
    await signInAs(page);
    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await page.getByRole("button", { name: "Approve lead" }).click();
    await expect(page.getByRole("heading", { name: "Decide on this held lead" })).toBeVisible(); // still held: nothing was sent
    const status = await withDb(async (client) => (await client.query("select status from leads where reference = $1", [reference])).rows[0].status);
    expect(status).toBe("held");
  });

  test("marking a lead handled moves it to 'Handled' and records who did it", async ({ page, request, baseURL }) => {
    const reference = await createLead(request, baseURL!, uniquePerson("Handled"), "new");
    await signInAs(page);
    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: reference }).getByRole("link", { name: reference }).click();
    await page.getByRole("button", { name: "Mark as handled" }).click();
    await expect(page.getByRole("status")).toContainText("Marked as handled");
    await expect(page.getByRole("button", { name: "Mark as handled" })).toHaveCount(0);

    await page.getByRole("link", { name: /All leads/ }).click();
    await expect(page.getByRole("row").filter({ hasText: reference })).toHaveCount(0);
    await page.getByRole("link", { name: "Handled" }).click();
    await expect(page.getByRole("row").filter({ hasText: reference })).toContainText("Handled");

    const actor = await withDb(async (client) =>
      (await client.query(`select o.email from lead_events e join leads l on l.id = e.lead_id join operators o on o.id = e.actor_id where l.reference = $1 and e.type = 'lead.handled'`, [reference])).rows,
    );
    expect(actor).toEqual([{ email: E2E_ACCESS.operator }]);
  });

  test("an unknown or malformed lead id is a 404, not an error page", async ({ page }) => {
    await signInAs(page);
    for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid", "1' or '1'='1"]) {
      const response = await page.goto(`/admin/leads/${encodeURIComponent(id)}`);
      expect(response?.status(), id).toBe(404);
    }
  });

  test("the pages are never cacheable and never indexable", async ({ page }) => {
    await signInAs(page);
    const response = await page.goto("/admin/leads");
    expect(response?.headers()["cache-control"]).toContain("no-store");
    expect(response?.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("works at phone width with no sideways scrolling of the page", async ({ page, request, baseURL }) => {
    await createLead(request, baseURL!, uniquePerson("Narrow"), "new");
    await signInAs(page);
    await page.setViewportSize({ width: 360, height: 740 });
    for (const path of ["/admin/leads"]) {
      await page.goto(path);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    }
  });
});

test.describe("accessibility (WCAG 2.2 AA via axe)", () => {
  test("the lead list and a lead page", async ({ page, request, baseURL }) => {
    const reference = await createLead(request, baseURL!, uniquePerson("Access"), "held");
    await signInAs(page);
    await page.goto("/admin/leads");
    await expect(page.getByRole("row").filter({ hasText: reference })).toBeVisible();
    await expectNoViolations(page, "inbox list");
    await page.getByRole("link", { name: reference }).click();
    await expect(page.getByRole("heading", { level: 1, name: reference })).toBeVisible();
    await expectNoViolations(page, "lead page (held)");
  });
});
