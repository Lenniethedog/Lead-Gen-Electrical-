export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the caller may try again (0 when allowed). */
  retryAfterSeconds: number;
}

interface Options {
  limit: number;
  windowMs: number;
  /** Upper bound on tracked keys; the oldest are evicted first. Protects memory from key floods. */
  maxKeys?: number;
  now?: () => number;
}

/**
 * Sliding-window-log limiter held in process memory.
 *
 * Scope, honestly stated: this is the app's burst control (cheap, no I/O). It is per instance, so
 * with N replicas the effective limit is up to N times higher, and it resets on deploy. The
 * authoritative, shared limits live in Cloudflare (per IP at the edge) and in the database
 * (per phone/email/IP velocity, which also feed the fraud score).
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: Options) {
    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /** Records an attempt for `key` and reports whether it is within the limit. */
  check(key: string): RateLimitResult {
    const now = this.now();
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

    if (recent.length >= this.limit) {
      const oldest = recent[0] ?? now;
      this.hits.set(key, recent);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.ceil((oldest + this.windowMs - now) / 1000) };
    }

    recent.push(now);
    // Re-insert so Map iteration order approximates least-recently-used for eviction.
    this.hits.delete(key);
    this.hits.set(key, recent);
    this.evictIfNeeded();
    return { allowed: true, remaining: this.limit - recent.length, retryAfterSeconds: 0 };
  }

  private evictIfNeeded() {
    while (this.hits.size > this.maxKeys) {
      const oldestKey = this.hits.keys().next().value;
      if (oldestKey === undefined) return;
      this.hits.delete(oldestKey);
    }
  }
}
