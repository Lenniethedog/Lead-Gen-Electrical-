import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * This project was forked from the roofing platform (UPSTREAM.md) and fixes are ported across by hand. A ported change can
 * quietly bring roofing words with it ("roofer", "your roof", a roof_repair slug), and a consumer, an electrical business or
 * the consent archive would see them. Nothing outside the tests may mention roofs.
 */
const ROOT = path.resolve(__dirname, "../..");
const SCANNED = ["src", "db", "scripts"];
const ROOFING = /roof/i; // tested after removing "proof", which contains it
const isTest = (file: string) => /\.test\.tsx?$/.test(file);

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

describe("no roofing left behind", () => {
  it("finds no roofing wording in the application, migrations' seeds or scripts", () => {
    const offenders: string[] = [];
    for (const top of SCANNED) {
      for (const file of filesUnder(path.join(ROOT, top))) {
        if (isTest(file) || !/\.(ts|tsx|sql|sh|css|mjs)$/.test(file)) continue;
        readFileSync(file, "utf8").split("\n").forEach((line, index) => {
          if (ROOFING.test(line.replace(/proof/gi, ""))) offenders.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });
});
