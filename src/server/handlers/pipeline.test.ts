import pino from "pino";
import { describe, expect, it } from "vitest";
import type { Database } from "@/lib/db/client";
import type { PipelineHealth } from "@/modules/alerts";
import { createPipelineHandler } from "./pipeline";

const db = {} as Database;
const logger = pino({ level: "silent" });

function harness(results: Array<PipelineHealth | Error>, ttlMs = 5_000) {
  let clock = 1_000_000;
  let calls = 0;
  const handler = createPipelineHandler({
    db,
    logger,
    ttlMs,
    now: () => clock,
    getHealth: async () => {
      const next = results[Math.min(calls, results.length - 1)]!;
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { handler, advance: (ms: number) => (clock += ms), calls: () => calls };
}

const healthy: PipelineHealth = { ok: true, problems: [] };

describe("GET /api/pipeline", () => {
  it("answers 200 and status ok when nothing is wrong", async () => {
    const response = await harness([healthy]).handler();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("answers 503 and names the problems (codes only) when something is", async () => {
    const response = await harness([{ ok: false, problems: ["worker_stale", "alerts_dead"] }]).handler();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "degraded", problems: ["worker_stale", "alerts_dead"] });
  });

  it("reports a failing database as degraded rather than throwing", async () => {
    const response = await harness([new Error("connection refused")]).handler();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "degraded", problems: ["database"] });
  });

  it("reuses an answer within the TTL, so a monitor or an abuser cannot turn it into database load", async () => {
    const { handler, advance, calls } = harness([healthy]);
    await handler();
    advance(4_999);
    await handler();
    expect(calls()).toBe(1);
    advance(2);
    await handler();
    expect(calls()).toBe(2);
  });

  it("shares one computation between simultaneous callers", async () => {
    const { handler, calls } = harness([healthy]);
    const responses = await Promise.all(Array.from({ length: 25 }, () => handler()));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(calls()).toBe(1);
  });

  it("recovers: a later healthy answer replaces a degraded one once the TTL passes", async () => {
    const { handler, advance } = harness([{ ok: false, problems: ["worker_stale"] }, healthy]);
    expect((await handler()).status).toBe(503);
    advance(6_000);
    expect((await handler()).status).toBe(200);
  });

  it("is never cached by a CDN or browser", async () => {
    const response = await harness([healthy]).handler();
    expect(response.headers.get("cache-control")).toMatch(/no-store/);
  });
});
