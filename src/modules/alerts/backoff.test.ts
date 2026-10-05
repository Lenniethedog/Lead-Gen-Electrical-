import { describe, expect, it } from "vitest";
import { MAX_ALERT_ATTEMPTS, retryDelayMs } from "./backoff";

describe("retryDelayMs", () => {
  const middle = () => 0.5; // zero jitter
  const low = () => 0;
  const high = () => 1;

  it("follows the documented schedule: 5 s, 15 s, 45 s, 2 min, 5 min, 15 min, 30 min", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => retryDelayMs(attempt, middle))).toEqual([
      5_000, 15_000, 45_000, 120_000, 300_000, 900_000, 1_800_000,
    ]);
  });

  it("jitters by at most +-20% so a provider outage does not become a synchronized retry wave", () => {
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      const base = retryDelayMs(attempt, middle);
      expect(retryDelayMs(attempt, low)).toBe(Math.round(base * 0.8));
      expect(retryDelayMs(attempt, high)).toBe(Math.round(base * 1.2));
    }
  });

  it("never shrinks as attempts increase (ignoring jitter) and is clamped outside the table", () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((attempt) => retryDelayMs(attempt, middle));
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    expect(retryDelayMs(0, middle)).toBe(5_000);
    expect(retryDelayMs(-3, middle)).toBe(5_000);
    expect(retryDelayMs(99, middle)).toBe(1_800_000);
  });

  it("gives up after eight attempts in total (one try plus seven delays), roughly an hour", () => {
    expect(MAX_ALERT_ATTEMPTS).toBe(8);
    const totalSeconds = [1, 2, 3, 4, 5, 6, 7].reduce((sum, attempt) => sum + retryDelayMs(attempt, middle) / 1000, 0);
    expect(totalSeconds).toBe(3_185); // 53 minutes: long enough to ride out a provider incident
  });
});
