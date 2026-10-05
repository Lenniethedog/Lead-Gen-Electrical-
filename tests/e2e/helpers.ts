import { expect, type Page } from "@playwright/test";
import { Client } from "pg";

if (["production", "staging"].includes(process.env.APP_ENV ?? "")) {
  throw new Error("The e2e suite creates real leads and must never run against staging/production configuration.");
}

export interface Person {
  name: string;
  phone: string;
  email: string;
}

/** Unique, libphonenumber-valid contact details per call, so runs never collide or look like duplicates. */
export function uniquePerson(label = "E2E"): Person {
  const n = Math.floor(100_000 + Math.random() * 899_999);
  return { name: `${label} Tester`, phone: `07123 ${String(n).slice(0, 6)}`, email: `e2e.${Date.now()}.${n}@example.com` };
}

export async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function leadsFor(email: string): Promise<Array<{ reference: string; status: string }>> {
  return withDb(async (client) => {
    const { rows } = await client.query(
      `select l.reference, l.status from leads l join lead_contacts c on c.lead_id = l.id where c.email_normalised = $1`,
      [email.toLowerCase()],
    );
    return rows;
  });
}

export const SERVICE = "Roof repair or leak";

/**
 * Clicks a choice tile the way a person does (the visible label), scoped to the radio groups so a
 * heading elsewhere on the page with the same words can never be hit by mistake.
 */
export async function chooseTile(page: Page, text: string) {
  await page.getByRole("radiogroup").getByText(text, { exact: true }).click();
}

export async function startForm(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What roofing work do you need?" })).toBeVisible();
}

/** Jump straight to a step by seeding the form's own session-storage state (exercises restore too). */
export async function seedProgress(
  page: Page,
  step: number,
  values: Record<string, unknown> = {},
  options: { elapsedMs?: number } = {},
) {
  await page.goto("/");
  await page.evaluate(
    ({ step, values, elapsedMs }) => {
      sessionStorage.setItem(
        "leadform.v1",
        JSON.stringify({
          v: 1,
          savedAt: Date.now(),
          step,
          idempotencyKey: crypto.randomUUID(),
          startedAt: Date.now() - elapsedMs,
          values: {
            service: "roof_repair",
            postcode: "BR6 0AA",
            coverage: { postcode: "BR6 0AA", areaName: "Orpington" },
            propertyType: "house",
            ownership: "owner",
            scope: "leak",
            urgency: "within_2_weeks",
            name: "",
            phone: "",
            email: "",
            notes: "",
            ...values,
          },
        }),
      );
    },
    { step, values, elapsedMs: options.elapsedMs ?? 60_000 },
  );
  await page.reload();
}

export async function fillContact(page: Page, person: Person) {
  await page.getByLabel("Your name").fill(person.name);
  await page.getByLabel("Phone number").fill(person.phone);
  await page.getByLabel("Email address").fill(person.email);
  await page.getByRole("checkbox", { name: /I agree that/ }).check();
}

/** Waits until the (invisible) Turnstile check has produced a token so the button is enabled. */
export async function submitEnquiry(page: Page) {
  const button = page.getByRole("button", { name: "Get my free quote" });
  await expect(button).toBeEnabled({ timeout: 15_000 });
  await button.click();
}
