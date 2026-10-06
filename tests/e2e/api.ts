import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_ACCESS, accessToken } from "./access";
import { withDb, type Person } from "./helpers";

const BROWSER_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** Submits an enquiry through the real public API. "held" omits the Turnstile token (which holds it for review). Returns the reference. */
export async function createLead(
  request: APIRequestContext,
  baseURL: string,
  person: Person,
  kind: "new" | "held",
  options: { service?: string; scope?: string; postcode?: string } = {},
): Promise<string> {
  const version = await withDb(async (client) => (await client.query("select version from consent_texts order by id desc limit 1")).rows[0].version as string);
  const response = await request.post(`${baseURL}/api/v1/leads`, {
    headers: { origin: baseURL, "idempotency-key": crypto.randomUUID(), "user-agent": BROWSER_UA },
    data: {
      service: options.service ?? "fault_repair",
      postcode: options.postcode ?? "BR6 0AA",
      propertyType: "house",
      ownership: "owner",
      scope: options.scope ?? "no_power",
      urgency: kind === "held" ? "within_2_weeks" : "emergency",
      contact: { name: person.name, phone: person.phone, email: person.email, notes: "Side gate code 4821" },
      consent: { accepted: true, textVersion: version },
      context: { elapsedMs: 45_000, ...(kind === "new" && { turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }), honeypot: "", pagePath: "/", attribution: {} },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { data: { reference: string } }).data.reference;
}

/** The inbox shows the stored E.164 form of a UK number: 07123 456789 -> +447123456789. */
export const e164 = (phone: string) => `+44${phone.replace(/\s/g, "").slice(1)}`;

export async function signInAs(page: Page, options?: Parameters<typeof accessToken>[0]) {
  await page.context().setExtraHTTPHeaders({ [E2E_ACCESS.header]: await accessToken(options) });
}
export const signInAsOwner = (page: Page) => signInAs(page, { email: E2E_ACCESS.owner });
