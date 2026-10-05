import { createHash, randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createLead, signInAsOwner } from "./api";
import { assignTo, createActiveClient, expectNoViolations, priceForTestLeads, problem, unique } from "./flows";
import { uniquePerson, withDb } from "./helpers";

/**
 * The business dashboard (stage 6) in a real browser, against the production build: staff invite a person, the person signs in with a
 * one-time link (a page with a BUTTON, because mail scanners open links), sees only their own business's leads, and loses access the
 * moment staff disable them. The emailed link cannot be read back (only its hash is stored, by design), so a known link is planted in the
 * database and then used through the real sign-in page.
 */
async function inviteViaAdmin(page: Page, name: string, email: string, role?: "owner" | "manager" | "agent") {
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Work email").fill(email);
  if (role) await page.locator("#user-role").selectOption(role);
  await page.getByRole("button", { name: "Invite and email a link" }).click();
  await expect(page.getByRole("status").first()).toContainText("Invited");
  // Wait for THIS person on the reloaded page: an earlier invite's notice may still be showing, and acting before the reload resets the form.
  await expect(page.getByText(email)).toBeVisible();
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

  test("credit: staff switch a business to prepaid and record a payment, leads are charged and refused when it runs out; a manager sees it, an agent does not", async ({ page, request, baseURL, browser }, testInfo) => {
    const stamp = unique();
    const business = `E2E Credit ${stamp}`;
    const managerEmail = `mgr-${stamp}@roofer.example`;
    const agentEmail = `agt-${stamp}@roofer.example`;
    await signInAsOwner(page);
    await priceForTestLeads(page); // £35 for the leads these tests create
    await createActiveClient(page, business);
    const clientPage = page.url();
    await inviteViaAdmin(page, "Mo Manager", managerEmail, "manager");
    await inviteViaAdmin(page, "Al Agent", agentEmail, "agent");

    // Prepaid with no credit: a paid lead is refused, with the reason, and the lead stays free.
    await page.getByLabel("How they pay").selectOption("prepaid");
    await page.locator("#billing").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText("Billing changed");
    const refusedLead = await createLead(request, baseURL!, uniquePerson("Credit"), "new");
    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: refusedLead }).getByRole("link", { name: refusedLead }).click();
    await page.locator("#assign-client").selectOption({ label: `${business} (covers this postcode)` });
    await page.getByRole("button", { name: "Assign lead" }).click();
    await expect(problem(page)).toContainText("does not have enough");

    // Record £70 received: exactly two leads' worth.
    await page.goto(clientPage);
    await page.getByLabel("What for").selectOption("top_up:bank_transfer");
    await page.getByLabel("Amount (£)").fill("70");
    await page.getByRole("button", { name: "Record it" }).click();
    await expect(page.getByRole("status").first()).toContainText("Recorded");
    await expect(page.getByLabel("Credit balance")).toHaveText("£70.00");
    await expectNoViolations(page, "client billing panel");

    // Two leads fit; the third is refused and the balance is untouched by the refusal.
    await assignTo(page, request, baseURL!, business);
    await assignTo(page, request, baseURL!, business);
    await page.goto(clientPage);
    await expect(page.getByLabel("Credit balance")).toHaveText("£0.00");
    await expect(page.locator("#billing").getByText("Lead charge").first()).toBeVisible();
    const third = await createLead(request, baseURL!, uniquePerson("Credit"), "new");
    await page.goto("/admin/leads");
    await page.getByRole("row").filter({ hasText: third }).getByRole("link", { name: third }).click();
    await page.locator("#assign-client").selectOption({ label: `${business} (covers this postcode)` });
    await page.getByRole("button", { name: "Assign lead" }).click();
    await expect(problem(page)).toContainText("does not have enough");

    const manager = await ownerContext(browser, baseURL!, testInfo.project);
    const agent = await ownerContext(browser, baseURL!, testInfo.project);
    try {
      await signInThroughPage(manager.page, await plantLink(managerEmail));
      await manager.page.getByRole("link", { name: "Billing" }).click();
      await expect(manager.page.getByRole("heading", { name: "Billing" })).toBeVisible();
      await expect(manager.page.getByText("Credit remaining").locator("xpath=following-sibling::dd[1]")).toHaveText("£0.00");
      await expect(manager.page.getByText("£70.00").first()).toBeVisible();
      await expect(manager.page.getByRole("heading", { name: "Credit history" })).toBeVisible();
      await expectNoViolations(manager.page, "business billing");

      await signInThroughPage(agent.page, await plantLink(agentEmail));
      await expect(agent.page.getByRole("link", { name: "Billing" })).toHaveCount(0);
      expect((await agent.page.goto("/dashboard/billing"))?.status()).toBe(404);
    } finally {
      await manager.context.close();
      await agent.context.close();
    }
  });

  test("a business reports a problem; staff uphold it; the charge is refunded and the lead leaves the business's list", async ({ page, request, baseURL, browser }, testInfo) => {
    const stamp = unique();
    const business = `E2E Dispute ${stamp}`;
    const email = `disp-${stamp}@roofer.example`;
    await signInAsOwner(page);
    await priceForTestLeads(page);
    await createActiveClient(page, business);
    const clientPage = page.url();
    await inviteViaAdmin(page, "Dee Disputes", email, "owner");
    await page.getByLabel("How they pay").selectOption("prepaid");
    await page.locator("#billing").getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("status").first()).toContainText("Billing changed");
    await page.getByLabel("What for").selectOption("top_up:bank_transfer");
    await page.getByLabel("Amount (£)").fill("70");
    await page.getByRole("button", { name: "Record it" }).click();
    await expect(page.getByLabel("Credit balance")).toHaveText("£70.00");
    const reference = await assignTo(page, request, baseURL!, business);
    await page.goto(clientPage);
    await expect(page.getByLabel("Credit balance")).toHaveText("£35.00");

    const owner = await ownerContext(browser, baseURL!, testInfo.project);
    try {
      const me = owner.page;
      await signInThroughPage(me, await plantLink(email));
      await me.getByRole("link", { name: new RegExp(reference) }).click();
      await me.getByRole("button", { name: "Accept this lead" }).click();
      await expect(me.getByRole("status").first()).toContainText("Accepted");

      // Reporting needs a reason; 'something else' needs words.
      await me.getByLabel("What is wrong").selectOption("other");
      await me.getByRole("button", { name: "Report a problem" }).click();
      await expect(problem(me)).toContainText("few words");
      await me.getByLabel("What is wrong").selectOption("wrong_number");
      await me.getByLabel("Tell us more (optional)").fill("Rang twice, a different person answered");
      await expectNoViolations(me, "report a problem form");
      await me.getByRole("button", { name: "Report a problem" }).click();
      await expect(me.getByRole("status").first()).toContainText("We will look at it");
      await expect(me.getByRole("heading", { name: "Problem reported" })).toBeVisible();
      await expect(me.getByRole("button", { name: "Withdraw it" })).toBeVisible();

      // Staff see it waiting, with the business's words, and uphold it.
      await page.goto("/admin/disputes");
      await expect(page.getByRole("link", { name: "Disputes (" })).toBeVisible();
      const card = page.getByRole("listitem").filter({ hasText: reference });
      await expect(card).toContainText("Rang twice, a different person answered");
      await card.getByLabel("Decision").selectOption("uphold");
      await card.getByLabel("Because").selectOption("confirmed_bad_number");
      await expectNoViolations(page, "disputes queue");
      await card.getByRole("button", { name: "Record the decision" }).click();
      await expect(page.getByRole("status").first()).toContainText("Upheld");
      await expect(page.getByRole("listitem").filter({ hasText: reference })).toHaveCount(0);

      // The money is back, and the lead is free for staff to decide about.
      await page.goto(clientPage);
      await expect(page.getByLabel("Credit balance")).toHaveText("£70.00");
      await expect(page.locator("#billing").getByText("Lead refunded").first()).toBeVisible();
      await page.goto("/admin/leads");
      await expect(page.getByRole("row").filter({ hasText: reference })).toBeVisible();

      // The business: gone from New leads, in History as Refunded without the person's details, and the problem shows as upheld.
      await me.goto("/dashboard");
      await expect(me.getByRole("link", { name: new RegExp(reference) })).toHaveCount(0);
      await me.goto("/dashboard/history");
      await me.getByRole("link", { name: new RegExp(reference) }).click();
      await expect(me.getByText("no longer with you")).toBeVisible();
      await expect(me.getByRole("link", { name: /^Call / })).toHaveCount(0);
      await me.goto("/dashboard/disputes");
      await expect(me.getByText("Upheld: refunded")).toBeVisible();
      await expectNoViolations(me, "problems reported");
    } finally {
      await owner.context.close();
    }
  });

  test("settings, areas and performance: roles are respected, a change is requested and handled by staff, the counts are right", async ({ page, request, baseURL, browser }, testInfo) => {
    const stamp = unique();
    const business = `E2E Account ${stamp}`;
    const ownerEmail = `own-${stamp}@roofer.example`;
    const managerEmail = `mgr-${stamp}@roofer.example`;
    const agentEmail = `agt-${stamp}@roofer.example`;
    await signInAsOwner(page);
    await priceForTestLeads(page);
    await createActiveClient(page, business);
    const clientPage = page.url();
    await inviteViaAdmin(page, "Olive Owner", ownerEmail, "owner");
    await inviteViaAdmin(page, "Mo Manager", managerEmail, "manager");
    await inviteViaAdmin(page, "Al Agent", agentEmail, "agent");
    const reference = await assignTo(page, request, baseURL!, business);

    const owner = await ownerContext(browser, baseURL!, testInfo.project);
    const manager = await ownerContext(browser, baseURL!, testInfo.project);
    const agent = await ownerContext(browser, baseURL!, testInfo.project);
    try {
      const me = owner.page;
      await signInThroughPage(me, await plantLink(ownerEmail));
      await me.getByRole("link", { name: new RegExp(reference) }).click();
      await me.getByRole("button", { name: "Accept this lead" }).click();
      await expect(me.getByRole("status").first()).toContainText("Accepted");
      await me.getByLabel("How did it go?").selectOption("won");
      await me.getByLabel(/Value of the quote/).fill("900");
      await me.getByRole("button", { name: "Save" }).click();
      await expect(me.getByRole("status").first()).toContainText("Saved");

      // Performance: exact counts for this fresh business, with the money.
      await me.getByRole("link", { name: "Performance" }).click();
      await expect(me.getByRole("heading", { name: "How you are doing" })).toBeVisible();
      const tile = (label: string) => me.getByText(label, { exact: true }).locator("xpath=following-sibling::dd[1]");
      await expect(tile("Leads received")).toHaveText("1");
      await expect(tile("Accepted")).toHaveText("1");
      await expect(tile("Jobs won")).toHaveText("1");
      await expect(tile("Value of jobs won")).toHaveText("£900.00");
      await expect(tile("Spent on leads")).toHaveText("£35.00");
      await expectNoViolations(me, "performance");

      // Settings: the owner changes where leads go.
      await me.getByRole("link", { name: "Settings" }).click();
      await me.getByLabel("Email address for leads").fill(`new-${stamp}@roofer.example`);
      await me.getByRole("button", { name: "Save" }).click();
      await expect(me.getByRole("status").first()).toContainText("Saved");
      await expect(me.getByLabel("Email address for leads")).toHaveValue(`new-${stamp}@roofer.example`);
      await expectNoViolations(me, "settings");

      // Areas: read-only, in words, with a way to ask.
      await me.getByRole("link", { name: "Areas" }).click();
      await expect(me.getByText("Postcode district BR6")).toBeVisible();
      await expect(me.getByText("Roof repair or leak")).toBeVisible();
      await me.getByLabel("What would you like changed").selectOption("coverage");
      await me.getByLabel("Tell us what you would like").fill("Please add BR1 and BR2");
      await me.getByRole("button", { name: "Send request" }).click();
      await expect(me.getByRole("status").first()).toContainText("We have your request");
      await expect(me.getByRole("listitem").filter({ hasText: "Please add BR1 and BR2" })).toContainText("Waiting");
      await expectNoViolations(me, "areas");

      // A manager sees where leads go but cannot change it; an agent has no Settings and sees no money.
      await signInThroughPage(manager.page, await plantLink(managerEmail));
      await manager.page.getByRole("link", { name: "Settings" }).click();
      await expect(manager.page.getByText("Only the owner can change where leads are sent").first()).toBeVisible();
      await expect(manager.page.getByLabel("Email address for leads")).toHaveCount(0);
      await manager.page.getByRole("button", { name: "Save" }).click();
      await expect(problem(manager.page)).toContainText("Nothing was different");

      await signInThroughPage(agent.page, await plantLink(agentEmail));
      await expect(agent.page.getByRole("link", { name: "Settings" })).toHaveCount(0);
      expect((await agent.page.goto("/dashboard/settings"))?.status()).toBe(404);
      await agent.page.goto("/dashboard/performance");
      await expect(agent.page.getByText("Leads received", { exact: true })).toBeVisible();
      await expect(agent.page.getByText("Spent on leads")).toHaveCount(0);

      // Staff: the request is waiting, shown with the nav count, and can be marked done.
      await page.goto(clientPage);
      await expect(page.getByRole("heading", { name: /Requests from the business \(1\)/ })).toBeVisible();
      await expect(page.getByText("Please add BR1 and BR2")).toBeVisible();
      await expect(page.getByRole("link", { name: /^Clients \(/ })).toBeVisible();
      await page.getByRole("button", { name: "Mark done" }).click();
      await expect(page.getByRole("status").first()).toContainText("Marked as done");
      await expect(page.getByRole("heading", { name: /Requests from the business/ })).toHaveCount(0);
      await me.goto("/dashboard/areas");
      await expect(me.getByRole("listitem").filter({ hasText: "Please add BR1 and BR2" })).toContainText("Done");
    } finally {
      await owner.context.close();
      await manager.context.close();
      await agent.context.close();
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
