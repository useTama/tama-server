/**
 * A cost for guessing a bearer token, so there is one before there is a
 * hostname.
 *
 * On loopback this is nearly inert and that is correct - the whole point is
 * that it is already in place on the day somebody puts a domain in front, when
 * the alternative is noticing afterwards.
 *
 * ## What the threat is, and is not
 *
 * Not brute force. `mintToken` makes 32 random bytes, so guessing one is not a
 * thing that happens, and saying so keeps this small: there is no need for
 * per-token lockouts, alerting, or anything that could lock the owner out of
 * their own vault.
 *
 * What is real is cheaper. An unbounded 401 loop is free CPU and free log
 * volume, and a log full of failures is a log where a genuine attempt is
 * invisible. So the goal is to make the tenth failure cost something and the
 * ten-thousandth cost nothing at all to serve.
 *
 * ## Why memory and not SQLite
 *
 * `pairing_attempts` is a table because a pairing code is a six-digit secret
 * that genuinely can be exhausted, and losing that counter on restart would
 * matter. This counter is the opposite: writing a row per failed request would
 * hand an unauthenticated caller a disk write per packet, which is a worse
 * amplifier than the one it set out to remove. Losing the state on restart is
 * fine - an attacker gains one window and the owner gains a server that starts
 * clean.
 */

const WINDOW_MS = 5 * 60_000;
/** Generous, because a wrong token pasted into a client retries on its own. */
const FAILURES_BEFORE_LOCK = 10;
const BASE_LOCK_MS = 30_000;
const MAX_LOCK_MS = 15 * 60_000;
/**
 * A ceiling on tracked callers, so the counter cannot itself become the memory
 * exhaustion it exists to bound. Evicts the entry closest to expiring.
 */
const MAX_TRACKED = 10_000;

type Entry = { failures: number; windowAt: number; lockedUntil: number; locks: number };

export type ThrottleState = { locked: boolean; retryAfterSec: number };

const UNLOCKED: ThrottleState = { locked: false, retryAfterSec: 0 };

export class AuthThrottle {
  private entries = new Map<string, Entry>();

  /** Injectable so a test does not have to sleep through a lockout. */
  constructor(private now: () => number = Date.now) {}

  /** Whether this caller is currently locked out. Cheap: one map lookup. */
  check(caller: string): ThrottleState {
    const entry = this.entries.get(caller);
    if (!entry) return UNLOCKED;
    const remaining = entry.lockedUntil - this.now();
    if (remaining <= 0) return UNLOCKED;
    return { locked: true, retryAfterSec: Math.ceil(remaining / 1000) };
  }

  /**
   * Count a rejected credential.
   *
   * Returns the state *after* counting, so the caller can turn the request that
   * crossed the threshold into the first 429 rather than waiting for the next.
   */
  fail(caller: string): ThrottleState {
    const now = this.now();
    const existing = this.entries.get(caller);
    const entry: Entry =
      existing && now - existing.windowAt < WINDOW_MS
        ? existing
        : { failures: 0, windowAt: now, lockedUntil: 0, locks: existing?.locks ?? 0 };

    entry.failures++;
    if (entry.failures >= FAILURES_BEFORE_LOCK) {
      entry.locks++;
      // Doubling per lock, so a caller that comes back for more waits longer
      // each time without the first mistake costing a quarter of an hour.
      entry.lockedUntil = now + Math.min(BASE_LOCK_MS * 2 ** (entry.locks - 1), MAX_LOCK_MS);
      entry.failures = 0;
      entry.windowAt = now;
    }

    this.entries.set(caller, entry);
    this.evictIfCrowded();
    return this.check(caller);
  }

  /**
   * A credential that worked. Clears the count, so a client that fumbles a
   * token and then fixes it is not carrying the failures into its next hour.
   */
  succeed(caller: string): void {
    this.entries.delete(caller);
  }

  /** Whether this caller just crossed into a lock, for one log line per lock. */
  justLocked(before: ThrottleState, after: ThrottleState): boolean {
    return !before.locked && after.locked;
  }

  private evictIfCrowded(): void {
    if (this.entries.size <= MAX_TRACKED) return;
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      const at = Math.max(entry.windowAt, entry.lockedUntil);
      if (at < oldestAt) {
        oldestAt = at;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }
}
