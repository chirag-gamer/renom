/**
 * Fixed-window in-memory rate limiter (FR-010 / SEC-013).
 * Keyed by caller-provided composite keys (e.g. `login:{ip}:{username}`).
 * Single-process only — acceptable for the one-machine MVP; swap interface for
 * shared store if remote nodes ever need it.
 */
interface WindowState {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, WindowState>();
  private lastSweep = Date.now();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Consume one unit for key. Returns retryAfterSec when limited, else null. */
  take(key: string, now = Date.now()): { limited: boolean; retryAfterSec: number } {
    this.sweep(now);
    const existing = this.buckets.get(key);
    if (!existing || now >= existing.resetAt) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict the oldest bucket, never wipe the table: a flood of fresh
        // keys must not reset the counters it is trying to dodge.
        const oldest = this.buckets.keys().next();
        if (!oldest.done) this.buckets.delete(oldest.value);
      }
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return { limited: false, retryAfterSec: 0 };
    }
    existing.count += 1;
    if (existing.count > this.max) {
      return {
        limited: true,
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { limited: false, retryAfterSec: 0 };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.buckets) {
      if (now >= v.resetAt) this.buckets.delete(k);
    }
  }
}
