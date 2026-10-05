import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "./rate-limit";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("SlidingWindowRateLimiter", () => {
  it("allows up to the limit then blocks, reporting when to retry", () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ limit: 3, windowMs: 60_000, now: time.now });

    expect(limiter.check("ip").remaining).toBe(2);
    time.advance(10_000);
    expect(limiter.check("ip").remaining).toBe(1);
    time.advance(10_000);
    expect(limiter.check("ip").remaining).toBe(0);

    time.advance(10_000);
    const blocked = limiter.check("ip");
    expect(blocked.allowed).toBe(false);
    // The oldest hit was 30s ago, so it frees up in 30s.
    expect(blocked.retryAfterSeconds).toBe(30);
  });

  it("recovers as old hits slide out of the window", () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ limit: 2, windowMs: 1_000, now: time.now });
    limiter.check("k");
    limiter.check("k");
    expect(limiter.check("k").allowed).toBe(false);
    time.advance(1_001);
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("does not count blocked attempts against the caller", () => {
    const time = clock();
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 1_000, now: time.now });
    limiter.check("k");
    for (let i = 0; i < 50; i += 1) limiter.check("k");
    time.advance(1_001);
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000 });
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").allowed).toBe(true);
  });

  it("bounds memory by evicting the oldest keys", () => {
    const limiter = new SlidingWindowRateLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3 });
    for (const key of ["a", "b", "c", "d"]) limiter.check(key);
    // "a" was evicted, so it is allowed again; "d" is still remembered and blocked.
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("d").allowed).toBe(false);
  });
});
