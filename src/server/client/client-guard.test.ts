import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guarantees for the business dashboard (stage 6, D45), checked on the source so a future page or action cannot quietly
 * skip authentication or choose a business from something the browser sent. Mirrors src/server/admin/admin-guard.test.ts.
 */
const root = path.resolve(import.meta.dirname, "../../..");
const dashboardDir = path.join(root, "src/app/dashboard");
const dalDir = path.join(root, "src/server/client");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const read = (file: string) => readFileSync(file, "utf8");
const rel = (file: string) => path.relative(dashboardDir, file);

const files = walk(dashboardDir).filter((file) => /\.(tsx?|ts)$/.test(file) && !file.endsWith(".test.ts"));
const entryPoints = files.filter((file) => /(^|\/)(page|layout|actions|route)\.tsx?$/.test(file));

/** The pages that exist BEFORE a session does: asking for a link, spending it. They are how a session is obtained. */
const PRE_SESSION = new Set(["layout.tsx", "login/page.tsx", "login/actions.ts", "signin/page.tsx", "signin/actions.ts"]);

const portalSource = read(path.join(dalDir, "portal.ts"));
const portalFunctions = [...portalSource.matchAll(/^export async function (\w+)/gm)].map((match) => match[1]!);

describe("every dashboard entry point authenticates through the data-access layer", () => {
  it("finds the entry points (so this test cannot pass by checking nothing)", () => {
    expect(entryPoints.map(rel).sort()).toEqual(
      [
        "layout.tsx",
        "login/page.tsx", "login/actions.ts",
        "signin/page.tsx", "signin/actions.ts",
        "(app)/layout.tsx", "(app)/page.tsx", "(app)/actions.ts",
        "(app)/history/page.tsx", "(app)/billing/page.tsx", "(app)/disputes/page.tsx", "(app)/settings/page.tsx", "(app)/settings/actions.ts", "(app)/areas/page.tsx", "(app)/areas/actions.ts", "(app)/performance/page.tsx",
        "(app)/leads/[id]/page.tsx", "(app)/leads/[id]/actions.ts",
      ].sort(),
    );
    expect(portalFunctions.length).toBeGreaterThanOrEqual(3);
  });

  it.each(entryPoints.filter((file) => !PRE_SESSION.has(rel(file))).map((file) => [rel(file), file] as const))(
    "%s calls an authenticating function",
    (_name, file) => {
      const source = read(file);
      const calls = [...portalFunctions, "signOutOfDashboard", "requireClientSession", "acceptLeadFromForm", "declineLeadFromForm", "logContactFromForm", "saveNotificationSettingsFromForm", "requestChangeFromForm"];
      expect(calls.some((fn) => new RegExp(`\\b${fn}\\(`).test(source))).toBe(true);
    },
  );

  it("EVERY data-access function calls requireClientSession before doing anything else", () => {
    for (const name of portalFunctions) {
      const body = portalSource.slice(portalSource.indexOf(`export async function ${name}`));
      const opening = body.slice(body.indexOf("{") + 1, body.indexOf("{") + 220);
      expect(opening, `portal.ts: ${name} must authenticate first`).toContain("requireClientSession()");
    }
  });

  it("no data-access function takes a business id: the business comes from the verified session, never from the browser", () => {
    for (const name of portalFunctions) {
      const signature = portalSource.slice(portalSource.indexOf(`export async function ${name}`)).split("{")[0]!;
      expect(signature, `${name} takes a business id`).not.toMatch(/client_?id|businessId/i);
    }
  });

  it("no dashboard file reaches around the data-access layer", () => {
    for (const file of files) {
      const source = read(file);
      for (const forbidden of ["@/server/db", "@/server/container", "@/server/admin", "@/lib/db", "@/modules/clientauth/", "@/modules/portal/", "kysely", 'from "pg"', "next/headers"]) {
        expect(source, `${rel(file)} imports ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("server actions are marked as such, and nothing else is exported from an actions file", () => {
    for (const file of files.filter((candidate) => candidate.endsWith("actions.ts"))) {
      const actions = read(file);
      expect(actions.trimStart().startsWith('"use server"'), file).toBe(true);
      const exported = [...actions.matchAll(/^export\s+(?:async\s+)?(\w+)\s+(\w+)/gm)].map((match) => `${match[1]} ${match[2]}`);
      expect(exported.every((entry) => entry.startsWith("function ")), `${file} exports something other than async functions`).toBe(true);
    }
  });
});

describe("the session cookie", () => {
  it("is read and written only in session.ts", () => {
    for (const name of readdirSync(dalDir).filter((n) => /\.ts$/.test(n) && !n.endsWith(".test.ts") && n !== "session.ts")) {
      expect(read(path.join(dalDir, name)), `${name} touches cookies`).not.toMatch(/\bcookies\(/);
    }
  });

  it("is HttpOnly, SameSite=Lax, and Secure whenever the site is served over https", () => {
    const session = read(path.join(dalDir, "session.ts"));
    expect(session).toContain("httpOnly: true");
    expect(session).toContain('sameSite: "lax"');
    expect(session).toContain("secure: getContainer().signIn.secureCookies");
    expect(session).toContain("__Host-");
  });
});

describe("the sign-in page does not sign anyone in by being opened", () => {
  it("spends the link only from a POSTed form (mail scanners open links with GET)", () => {
    const page = read(path.join(dashboardDir, "signin/page.tsx"));
    expect(page).not.toContain("completeSignIn(");
    expect(page).toContain("action={completeSignInAction}");
    expect(read(path.join(dashboardDir, "signin/actions.ts")).trimStart().startsWith('"use server"')).toBe(true);
  });
});
