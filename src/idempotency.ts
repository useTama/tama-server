import type { Database } from "bun:sqlite";

/**
 * A client retrying a request that already succeeded must not create a second note.
 *
 * This is not an edge case. A device with a flash-backed queue retries whenever a
 * response is lost, and a response is lost exactly when the network is bad, which
 * is exactly when the queue is doing its job. Without this, the queue manufactures
 * duplicates as its normal behaviour.
 *
 * The UNIQUE primary key is what makes the concurrent case safe: two simultaneous
 * retries race to insert, one wins, the loser is told the work is already in flight.
 */

const TTL_MS = 24 * 60 * 60 * 1000;

export type Claim =
  | { state: "fresh" }
  | { state: "duplicate"; response: unknown }
  | { state: "in-flight" };

/** Try to claim a key. Only a "fresh" claim may proceed to do the work. */
export function claim(db: Database, key: string): Claim {
  try {
    db.query("INSERT INTO idempotency (key, status, created_at) VALUES (?, 'pending', ?)")
      .run(key, new Date().toISOString());
    return { state: "fresh" };
  } catch {
    const row = db.query("SELECT status, response FROM idempotency WHERE key = ?")
      .get(key) as { status: string; response: string | null } | null;
    if (!row) return { state: "fresh" }; // swept between insert and read; let it through
    if (row.status === "done" && row.response) {
      return { state: "duplicate", response: JSON.parse(row.response) };
    }
    return { state: "in-flight" };
  }
}

/** Record the result so a later retry replays it instead of writing again. */
export function complete(db: Database, key: string, response: unknown): void {
  db.query("UPDATE idempotency SET status = 'done', response = ? WHERE key = ?")
    .run(JSON.stringify(response), key);
}

/** The work failed. Release the claim so a retry can genuinely retry. */
export function release(db: Database, key: string): void {
  db.query("DELETE FROM idempotency WHERE key = ?").run(key);
}

export function sweep(db: Database): number {
  const cutoff = new Date(Date.now() - TTL_MS).toISOString();
  return db.query("DELETE FROM idempotency WHERE created_at < ?").run(cutoff).changes;
}
