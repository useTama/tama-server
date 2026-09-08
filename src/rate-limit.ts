/**
 * A per-sender ceiling, checked at admission.
 *
 * Every allowlisted sender could ping as fast as they could type, and nothing
 * stopped them. Three costs, all of them the owner's: every ask is a paid model
 * call on the owner's key, every captured voice note is a permanent file in the
 * vault (invariant 1: append-only, never edited, so junk is deleted by hand),
 * and a business number that sends in bursts is a business number Meta can
 * flag.
 *
 * `MAX_INFLIGHT` in routes.ts does not cover this. It is a global concurrency
 * cap, so in a group it makes things worse: one person spamming holds both
 * slots and the owner's own question is the one refused.
 *
 * Three decisions worth stating.
 *
 * **It answers a fixed number, then says so once, then goes quiet.** Replying
 * to everything past the ceiling is the amplification rather than the
 * mitigation - a bot dutifully saying "slow down" two hundred times is doing
 * the sender's work with the owner's phone number. `notified` is what makes the
 * second reply not happen.
 *
 * **Capture and ask are counted separately.** They fail differently: capture
 * costs CPU and writes a file, ask costs money. One number would be wrong for
 * one of them.
 *
 * **A drop is counted, not silently discarded.** Without the counter, "the bot
 * ignored me" is indistinguishable from a bug, and the owner has no way to see
 * that a limit fired at all.
 */

import type { Database } from "bun:sqlite";

/**
 * Windows and ceilings.
 *
 * Ask is the number the owner asked for: five, then one notice. Capture is
 * deliberately far looser, because dictating five thoughts in a row is the
 * product working rather than abuse, and a limit that drops the owner's own
 * captures during a busy minute is worse than no limit at all.
 *
 * Not configurable yet. Anyone who has to read the docs to avoid a surprise
 * bill has already had the surprise, so the defaults come first and the config
 * block follows once these have met a real vault.
 */
export const WINDOW_MS = 60_000;
export const ASK_PER_WINDOW = 5;
export const CAPTURE_PER_WINDOW = 20;

/**
 * `allow` proceed. `notify` refuse, and tell them once. `drop` refuse in
 * silence, because they have already been told.
 */
export type Admission = "allow" | "notify" | "drop";

export function limitFor(kind: "audio" | "text"): number {
  return kind === "audio" ? CAPTURE_PER_WINDOW : ASK_PER_WINDOW;
}

/**
 * Claim one unit of a sender's budget.
 *
 * Takes the clock rather than reading it, so a window boundary is testable
 * without waiting a minute.
 *
 * `subject` must already be pseudonymised. The callers hold a keyed hash of the
 * sender for exactly this reason, and a phone number in a table nothing ever
 * wipes would undo the discarding the rest of the transport is careful about.
 */
export function admit(
  db: Database,
  scope: string,
  subject: string,
  limit: number,
  now: Date = new Date(),
  windowMs: number = WINDOW_MS,
): Admission {
  const row = db
    .query("SELECT window_at, used, notified FROM rate_limits WHERE scope = ? AND subject = ?")
    .get(scope, subject) as { window_at: string; used: number; notified: number } | null;

  const startedAt = row ? Date.parse(row.window_at) : NaN;
  // An unparseable or absent stamp starts a fresh window rather than throwing:
  // a corrupt counter row must not be able to refuse a legitimate message.
  const expired = !row || !Number.isFinite(startedAt) || now.getTime() - startedAt >= windowMs;

  if (expired) {
    db.query(
      `INSERT INTO rate_limits (scope, subject, window_at, used, notified, dropped) VALUES (?, ?, ?, 1, 0, 0)
       ON CONFLICT(scope, subject) DO UPDATE SET window_at = excluded.window_at, used = 1, notified = 0`,
    ).run(scope, subject, now.toISOString());
    return "allow";
  }

  if (row.used < limit) {
    db.query("UPDATE rate_limits SET used = used + 1 WHERE scope = ? AND subject = ?").run(scope, subject);
    return "allow";
  }

  // Over the ceiling. The dropped counter climbs either way; only the first one
  // past it earns a reply.
  db.query("UPDATE rate_limits SET dropped = dropped + 1 WHERE scope = ? AND subject = ?").run(scope, subject);
  if (row.notified === 0) {
    db.query("UPDATE rate_limits SET notified = 1 WHERE scope = ? AND subject = ?").run(scope, subject);
    return "notify";
  }
  return "drop";
}

/** What a sender is told, once, when they cross the line. */
export function noticeFor(kind: "audio" | "text"): string {
  return kind === "audio"
    ? "That is more voice notes than Tama takes in one minute, so this one was not saved. Wait a minute and send it again."
    : "That is more questions than Tama answers in one minute. Wait a minute and ask again.";
}

/** For the digest, and for an owner wondering whether a limit fired. */
export function dropped(db: Database, scope?: string): number {
  const row = scope
    ? db.query("SELECT sum(dropped) AS n FROM rate_limits WHERE scope = ?").get(scope)
    : db.query("SELECT sum(dropped) AS n FROM rate_limits").get();
  return ((row as { n: number | null } | null)?.n) ?? 0;
}
