import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { signInAsOwner } from "./api";
import { assignTo, createActiveClient, expectNoViolations, priceForTestLeads, problem, unique } from "./flows";
import { withDb } from "./helpers";

/**
 * The business dashboard (stage 6) in a real browser, against the production build: staff invite a person, the person signs in with a
 * one-time link (a page with a BUTTON, because mail scanners open links), sees only their own business's leads, and loses access the
 * moment staff disable them. The emailed link cannot be read back (only its hash is stored, by design), so a known link is planted in the
 * database and then used through the real sign-in page.
 */
async function inviteViaAdmin(page: Page, name: string, email: string) {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Invite and email a link" }).click();
  await expect(page.getByRole("status").first()).toContainText("Invited");
}

/** A sign-in link the test knows the secret of, for a person who exists. */
async function plantLink(email: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token, "utf8").digest();
  await withDb(async (client) => {
    const user = (await client.query("select id from client_users where email = $1", [email])).rows[0];
    if (!user) throw new Error(`no client user ${email}`);
    await client.query("insert into client_login_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + interval '15 minutes')", [user.id, hash]);
  });
  return `/dashboard/signin?token=${token}`;
}

async function signInThroughPage(page: Page, link: string) {
  await page.goto(link);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** A separate browser identity: a business owner on their own phone, with no staff access header. */
async function ownerContext(browser: Browser, baseURL: string, project: { use: { viewport?: { width: number; height: number } | null; userAgent?: string; isMobile?: boolean; hasTouch?: boolean; deviceScaleFactor?: number } }) {
  const context = await browser.newContext({ baseURL, viewport: project.use.viewport ?? undefined, userAgent: project.use.userAgent, isMobile: project.use.isMobile, hasTouch: project.use.hasTouch, deviceScaleFactor: project.use.deviceScaleFactor });
  return { context, page: await context.newPage() };
}

test.describe("the business dashboard", () => {
  test("staff invite someone; they sign in with a link, see their lead and the person's details, and signing out ends it", async ({ page, request, baseURL, browser }, testInfo) => {
    const stamp = unique();
    const business = `E2E Dash ${stamp}`;
    const email = `dash-${stamp}@roofer.example`;

    await signInAsOwner(page);
    await priceForTestLeads(page);
    await createActiveClient(page, business);
    await inviteViaAdmin(page, "Dana Roofer", email);
    await expect(page.getByText(email)).toBeVisible();
    await expect(page.getByText("Invited, not signed in yet")).toBeVisible();
    const reference = await assignTo(page, request, baseURL!, business);

    const owner = await ownerContext(browser, baseURL!, testInfo.project);
    try {
      const me = owner.page;
      // Not signed in: the dashboard is the sign-in page, never half a dashboard.
      await me.goto("/dashboard");
      await expect(me).toHaveURL(/\/dashboard\/login/);

      // Opening the emailed link signs nobody in. Only the button does.
      const link = await plantLink(email);
      await me.goto(link);
      await expect(me.getByRole("heading", { name: "Ready to sign in?" })).toBeVisible();
      await me.goto("/dashboard");
      await expect(me).toHaveURL(/\/dashboard\/login/);

      await signInThroughPage(me, link);
      await expect(me.getByRole("heading", { name: "New leads" })).toBeVisible();
      await expect(me.getByRole("link", { name: new RegExp(reference) })).toBeVisible();
      await expectNoViolations(me, "dashboard list");

      // The same link, a second time, does nothing.
      const stranger = await ownerContext(browser, baseURL!, testInfo.project);
      try {
        await stranger.page.goto(link);
        await stranger.page.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(stranger.page).toHaveURL(/\/dashboard\/login\?error=link/);
        await expect(problem(stranger.page)).toContainText("already been used");
      } finally {
        await stranger.context.close();
      }

      // The lead: the person's details, a tap-to-call link, and the job.
      await me.getByRole("link", { name: new RegExp(reference) }).click();
      await expect(me.getByRole("heading", { name: /^Contact / })).toBeVisible();
      await expect(me.getByRole("link", { name: /^Call \+44/ })).toHaveAttribute("href", /^tel:\+44\d+$/);
      await expect(me.getByRole("heading", { name: "The job" })).toBeVisible();
      await expectNoViolations(me, "dashboard lead");

      // The reveal is on the record.
      const reveals = await withDb(async (client) => (await client.query("select count(*)::int as n from audit_logs where action = 'lead.contact_viewed' and actor_type = 'client_user'")).rows[0].n as number);
      expect(reveals).toBeGreaterThanOrEqual(1);

      // Signing out ends the session for real: the old cookie no longer works.
      const cookies = await owner.context.cookies();
      const session = cookies.find((cookie) => cookie.name === "lg_client");
      expect(session, "a session cookie was set").toBeDefined();
      expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax" });
      await me.getByRole("button", { name: "Sign out" }).click();
      await expect(me).toHaveURL(/\/dashboard\/login/);
      await owner.context.addCookies([session!]);
      await me.goto("/dashboard");
      await expect(me).toHaveURL(/\/dashboard\/login/);
    } finally {
      await owner.context.close();
    }
  });

  test("a business cannot open another business's lead, and staff disabling a person signs them out at once", async ({ page, request, baseURL, browser }, testInfo) => {
    const stamp = unique();
    const first = `E2E Dash A ${stamp}`;
    const second = `E2E Dash B ${stamp}`;
    const firstEmail = `a-${stamp}@roofer.example`;
    const secondEmail = `b-${stamp}@roofer.example`;

    await signInAsOwner(page);
    await priceForTestLeads(page);
    await createActiveClient(page, first);
    await inviteViaAdmin(page, "Person A", firstEmail);
    const firstClientPage = page.url();
    const reference = await assignTo(page, request, baseURL!, first);
    await createActiveClient(page, second);
    await inviteViaAdmin(page, "Person B", secondEmail);

    const a = await ownerContext(browser, baseURL!, testInfo.project);
    const b = await ownerContext(browser, baseURL!, testInfo.project);
    try {
      await signInThroughPage(a.page, await plantLink(firstEmail));
      await signInThroughPage(b.page, await plantLink(secondEmail));

      // A's lead id, read from A's own list, is simply not found for B (the same page as one that never existed).
      await a.page.getByRole("link", { name: new RegExp(reference) }).click();
      await expect(a.page).toHaveURL(/\/dashboard\/leads\/[0-9a-f-]{36}$/);
      const leadPath = new URL(a.page.url()).pathname;
      await expect(b.page.getByRole("link", { name: new RegExp(reference) })).toHaveCount(0);
      const response = await b.page.goto(leadPath);
      expect(response?.status()).toBe(404);
      await expect(b.page.getByText("Call +44")).toHaveCount(0);
      const bogus = await b.page.goto("/dashboard/leads/00000000-0000-4000-8000-000000000000");
      expect(bogus?.status()).toBe(404);

      // Staff disable A: the very next request from A is the sign-in page.
      await page.goto(firstClientPage);
      await page.locator("li").filter({ hasText: firstEmail }).getByRole("button", { name: "Disable" }).click();
      await expect(page.getByRole("status").first()).toContainText("Disabled");
      await a.page.goto("/dashboard");
      await expect(a.page).toHaveURL(/\/dashboard\/login/);
      // And a fresh link for a disabled person is useless.
      await a.page.goto(await plantLink(firstEmail));
      await a.page.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(a.page).toHaveURL(/\/dashboard\/login\?error=link/);
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("a business accepts one lead and records the call, and declines another, which leaves its list", async ({ page, request, baseURL, browser }, testInfo) => {
    const stamp = unique();
    const business = `E2E Answer ${stamp}`;
    const email = `answer-${stamp}@roofer.example`;
    await signInAsOwner(page);
    await priceForTestLeads(page);
    await createActiveClient(page, business);
    await inviteViaAdmin(page, "Alex Answers", email);
    const keep = await assignTo(page, request, baseURL!, business);
    const drop = await assignTo(page, request, baseURL!, business);

    const owner = await ownerContext(browser, baseURL!, testInfo.project);
    try {
      const me = owner.page;
      await signInThroughPage(me, await plantLink(email));

      // Accept.
      await me.getByRole("link", { name: new RegExp(keep) }).click();
      await expect(me.getByRole("heading", { name: "Do you want this lead?" })).toBeVisible();
      await expectNoViolations(me, "lead awaiting an answer");
      await me.getByRole("button", { name: "Accept this lead" }).click();
      await expect(me.getByRole("status").first()).toContainText("Accepted");
      await expect(me.getByRole("heading", { name: "Do you want this lead?" })).toHaveCount(0);

      // Record the call: a value only goes with a quote or a win.
      await me.getByLabel("How did it go?").selectOption("spoke");
      await me.getByLabel(/Value of the quote/).fill("100");
      await me.getByRole("button", { name: "Save" }).click();
      await expect(problem(me)).toContainText("only for a quote or a job won");
      await me.getByLabel("How did it go?").selectOption("won");
      await me.getByLabel(/Value of the quote/).fill("1,500");
      await me.getByLabel("Note (optional)").fill("Roof repair, starts Monday");
      await me.getByRole("button", { name: "Save" }).click();
      await expect(me.getByRole("status").first()).toContainText("Saved");
      await expect(me.getByRole("listitem").filter({ hasText: "Won the job" })).toBeVisible();
      await expect(me.getByRole("listitem").filter({ hasText: "£1,500.00" })).toBeVisible();
      await expect(me.getByRole("listitem").filter({ hasText: "Roof repair, starts Monday" })).toBeVisible();
      await expectNoViolations(me, "lead after accepting");

      // Decline the other one: it leaves New leads and appears in History as Declined, without the person's details.
      await me.goto("/dashboard");
      await me.getByRole("link", { name: new RegExp(drop) }).click();
      await me.getByLabel("Or decline it, because").selectOption("not_my_work");
      await me.getByRole("button", { name: "Decline", exact: true }).click();
      await expect(me).toHaveURL(/\/dashboard\?notice=declined/);
      await expect(me.getByRole("status").first()).toContainText("Declined");
      await expect(me.getByRole("link", { name: new RegExp(drop) })).toHaveCount(0);
      await expect(me.getByRole("link", { name: new RegExp(keep) })).toBeVisible();
      await me.goto("/dashboard/history");
      await me.getByRole("link", { name: new RegExp(drop) }).click();
      await expect(me.getByText("no longer with you")).toBeVisible();
      await expect(me.getByRole("link", { name: /^Call / })).toHaveCount(0);
      await expect(me.getByRole("button", { name: "Accept this lead" })).toHaveCount(0);

      // The lead is free again for staff.
      await page.goto("/admin/leads");
      await expect(page.getByRole("row").filter({ hasText: drop })).toBeVisible();
    } finally {
      await owner.context.close();
    }
  });

  test("asking for a link says the same thing for a stranger as for a person who has an account", async ({ browser, baseURL }, testInfo) => {
    const owner = await ownerContext(browser, baseURL!, testInfo.project);
    try {
      const me = owner.page;
      const outcomes: string[] = [];
      for (const address of [`nobody-${unique()}@nowhere.example`, "not an email at all"]) {
        await me.goto("/dashboard/login");
        await me.getByLabel("Your work email").fill(address.includes("@") ? address : "x@y.zz");
        await me.getByRole("button", { name: "Email me a sign-in link" }).click();
        await expect(me.getByRole("heading", { name: "Check your email" })).toBeVisible();
        outcomes.push(await me.getByRole("status").innerText());
      }
      expect(new Set(outcomes).size).toBe(1);
      await expect(me).toHaveURL(/\/dashboard\/login\?sent=1$/);
      expect(me.url()).not.toContain("@");
      await expectNoViolations(me, "sign-in sent");
      await me.goto("/dashboard/signin?token=short");
      await expect(problem(me)).toContainText("not valid");
      await expectNoViolations(me, "sign-in invalid link");
    } finally {
      await owner.context.close();
    }
  });
});
