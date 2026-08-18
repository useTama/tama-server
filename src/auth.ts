import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Per-device tokens, individually revocable.
 *
 * Losing a device revokes one token, not the install. Tokens are hashed at rest,
 * so a stolen database does not hand over working credentials.
 *
 * Two ways to get one, because a device has no keyboard:
 *   - a pairing code, typed into a provisioning portal or an app
 *   - minted directly with the admin token, which is what you do for a dev board
 *     you are about to flash
 */

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type TokenRow = { id: string; device_name: string; created_at: string; last_used: string | null };

export function mintToken(db: Database, deviceName: string): { id: string; token: string } {
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  db.query(
    "INSERT INTO tokens (id, hash, device_name, created_at) VALUES (?, ?, ?, ?)",
  ).run(id, sha256(token), deviceName.slice(0, 64), new Date().toISOString());
  return { id, token };
}

/** Returns the device name if the token is valid and not revoked. */
export function verifyToken(db: Database, token: string): { id: string; deviceName: string } | null {
  if (!token) return null;
  const row = db
    .query("SELECT id, device_name FROM tokens WHERE hash = ? AND revoked_at IS NULL")
    .get(sha256(token)) as { id: string; device_name: string } | null;
  if (!row) return null;
  db.query("UPDATE tokens SET last_used = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  return { id: row.id, deviceName: row.device_name };
}

export function revokeToken(db: Database, id: string): boolean {
  const r = db.query("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return r.changes > 0;
}

export function listTokens(db: Database): TokenRow[] {
  return db
    .query("SELECT id, device_name, created_at, last_used FROM tokens WHERE revoked_at IS NULL ORDER BY created_at")
    .all() as TokenRow[];
}

/** Constant-time compare, so the admin token cannot be guessed a byte at a time. */
export function adminTokenOk(given: string, expected: string): boolean {
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- pairing codes -------------------------------------------------------

const CODE_TTL_MS = 10 * 60 * 1000;

/** Short, single-use, short-lived. Digits only, because it gets typed by hand. */
export function newPairingCode(db: Database): { code: string; expiresAt: string } {
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MS).toISOString();
  db.query("INSERT OR REPLACE INTO pairing_codes (code, created_at, expires_at) VALUES (?, ?, ?)")
    .run(code, now.toISOString(), expiresAt);
  return { code, expiresAt };
}

export type PairResult =
  | { ok: true; id: string; token: string }
  | { ok: false; reason: "unknown" | "expired" | "used" };

export function redeemPairingCode(db: Database, code: string, deviceName: string): PairResult {
  const row = db.query("SELECT code, expires_at, used_at FROM pairing_codes WHERE code = ?")
    .get(code) as { code: string; expires_at: string; used_at: string | null } | null;

  if (!row) return { ok: false, reason: "unknown" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "expired" };

  db.query("UPDATE pairing_codes SET used_at = ? WHERE code = ?").run(new Date().toISOString(), code);
  const { id, token } = mintToken(db, deviceName);
  return { ok: true, id, token };
}

export function sweepExpiredCodes(db: Database): void {
  db.query("DELETE FROM pairing_codes WHERE expires_at < ?").run(new Date().toISOString());
}
