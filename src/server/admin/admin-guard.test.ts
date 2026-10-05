import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guarantees for the operator inbox, checked on the source itself so a future page or
 * action cannot quietly skip authentication (the failure mode that matters: a page that renders
 * consumers' phone numbers to anyone).
 */
const root = path.resolve(import.meta.dirname, "../../..");
const adminDir = path.join(root, "src/app/admin");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const files = walk(adminDir).filter((file) => /\.(tsx?|ts)$/.test(file) && !file.endsWith(".test.ts"));
const entryPoints = files.filter((file) => /(^|\/)(page|layout|actions|route)\.tsx?$/.test(file));
const read = (file: string) => readFileSync(file, "utf8");

/**
 * The data-access layer: every file in src/server/admin except the two that implement authentication itself. Derived from the code,
 * not a hand-kept list, so a new DAL file or function cannot be forgotten by this test.
 */
const dalDir = path.join(root, "src/server/admin");
const dalFiles = readdirSync(dalDir).filter((name) => /\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !["session.ts", "authorizer.ts"].includes(name));
const dalFunctions = dalFiles.flatMap((name) =>
  [...read(path.join(dalDir, name)).matchAll(/^export async function (\w+)/gm)].map((match) => ({ file: name, name: match[1]! })),
);
const AUTHENTICATING = dalFunctions.map((fn) => fn.name);

describe("every admin entry point authenticates through the data-access layer", () => {
  it("finds the entry points and the data-access functions (so this test cannot pass by checking nothing)", () => {
    expect(entryPoints.map((file) => path.relative(adminDir, file)).sort()).toEqual(
      [
        "layout.tsx", "page.tsx",
        "leads/page.tsx", "leads/[id]/page.tsx", "leads/actions.ts",
        "clients/page.tsx", "clients/new/page.tsx", "clients/[id]/page.tsx", "clients/actions.ts",
        "coverage/page.tsx", "pricing/page.tsx", "pricing/actions.ts",
        "routing/page.tsx", "routing/actions.ts",
        "deliveries/page.tsx", "deliveries/actions.ts",
      ].sort(),
    );
    expect(dalFiles.sort()).toEqual(["assignments.ts", "billing.ts", "clients.ts", "delivery.ts", "inbox.ts", "pricing.ts", "routing.ts", "users.ts"]);
    expect(AUTHENTICATING.length).toBeGreaterThanOrEqual(20);
  });

  it.each(entryPoints.map((file) => [path.relative(adminDir, file), file] as const))("%s calls an authenticating function", (_name, file) => {
    const source = read(file);
    expect(AUTHENTICATING.some((fn) => new RegExp(`\\b${fn}\\(`).test(source))).toBe(true);
  });

  it("EVERY data-access function calls requireOperator before doing anything else", () => {
    for (const { file, name } of dalFunctions) {
      const source = read(path.join(dalDir, file));
      const body = source.slice(source.indexOf(`export async function ${name}`));
      const opening = body.slice(body.indexOf("{") + 1, body.indexOf("{") + 260);
      expect(opening, `${file}: ${name} must authenticate first`).toContain("requireOperator()");
    }
  });

  it("no admin file reaches around the data-access layer", () => {
    for (const file of files) {
      const source = read(file);
      for (const forbidden of ["@/server/db", "@/server/container", "@/server/admin/session", "@/server/admin/authorizer", "@/lib/db", "kysely", "from \"pg\""]) {
        expect(source, `${path.relative(root, file)} imports ${forbidden}`).not.toContain(forbidden);
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

  it("an owner-only action is also guarded in the service, not just the page (defence in depth)", () => {
    const privacyService = read(path.join(root, "src/modules/privacy/service.ts"));
    expect(privacyService).toContain('input.actor.operator.role !== "owner"');
  });
});

describe("the proxy gate", () => {
  const proxy = read(path.join(root, "src/proxy.ts"));

  it("matches /admin and everything under it", () => {
    expect(proxy).toMatch(/matcher:\s*\[\s*"\/admin",\s*"\/admin\/:path\*"\s*\]/);
  });

  it("refuses with 403 and sends no-store", () => {
    expect(proxy).toContain("status: 403");
    expect(proxy).toContain('"cache-control": "no-store"');
  });

  it("never logs the token or the email, only a reason code", () => {
    expect(proxy).not.toMatch(/log\w*\.[a-z]+\([^)]*(email|token|jwt|header)/i);
  });
});
