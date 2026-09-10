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

export type TokenRow = {
  id: string;
  device_name: string;
  created_at: string;
  last_used: string | null;
  audience: string | null;
  caps: string | null;
  read_view: string | null;
  write_view: string | null;
  expires_at: string | null;
  client_id: string | null;
};

/**
 * What a token is allowed to do, beyond which audience it speaks as.
 *
 * All optional, and absent means unrestricted, so `mintToken(db, name)` still
 * mints the owner's own device exactly as it always did.
 */
export type TokenScope = {
  audience?: string;
  caps?: string;
  readView?: string;
  writeView?: string;
  /** OAuth only. A device token never expires; an access token must. */
  expiresAt?: string;
  /** RFC 8707 audience. NULL on a device token means "not audience-bound". */
  resource?: string;
  /** Which connector holds this, so Credentials can tell them apart. */
  clientId?: string;
  /** The paired refresh token, hashed. Rotated in place on each use. */
  refreshHash?: string;
};

export function mintToken(db: Database, deviceName: string, scope: string | TokenScope = {}): { id: string; token: string } {
  // A bare string stays the audience, because that is what every existing
  // caller passes and a silent change of meaning here is a silent change of
  // access.
  const s: TokenScope = typeof scope === "string" ? { audience: scope } : scope;
  const id = randomBytes(8).toString("hex");
  const token = randomBytes(32).toString("hex");
  db.query(
    `INSERT INTO tokens (id, hash, device_name, created_at, audience, caps, read_view, write_view,
                         expires_at, resource, client_id, refresh_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    sha256(token),
    deviceName.slice(0, 64),
    new Date().toISOString(),
    s.audience ?? null,
    s.caps ?? null,
    s.readView ?? null,
    s.writeView ?? null,
    s.expiresAt ?? null,
    s.resource ?? null,
    s.clientId ?? null,
    s.refreshHash ?? null,
  );
  return { id, token };
}

/** Returns the device name if the token is valid and not revoked. */
/**
 * `audience` is null for the owner's own devices, which is every token minted
 * before audiences existed. Returning it here is what lets a route decide what
 * a caller may see without trusting the caller to say.
 */
export type VerifiedToken = {
  id: string;
  deviceName: string;
  audience?: string;
  /** Present on an OAuth grant. Its absence is what makes a device token one. */
  clientId?: string;
  expiresAt?: string;
  /** Raw columns. `resolveGrant` in grants.ts turns these into a Grant. */
  caps?: string;
  readView?: string;
  writeView?: string;
};

/**
 * `resource` is the audience this request is being made to, when the caller
 * knows it. Passing it is what enforces RFC 8707 binding.
 *
 * The check lives here rather than at the call site deliberately: this is the
 * one place in the codebase that turns a secret into an identity, so a future
 * route cannot forget it. It costs one comparison against a column that is NULL
 * on every device token - which is also the whole coexistence story, expressed
 * as data rather than as a branch.
 */
export function verifyToken(db: Database, token: string, resource?: string): VerifiedToken | null {
  if (!token) return null;
  const row = db
    .query(
      `SELECT id, device_name, audience, caps, read_view, write_view, expires_at, resource, client_id, last_used
       FROM tokens WHERE hash = ? AND revoked_at IS NULL`,
    )
    .get(sha256(token)) as any;
  if (!row) return null;

  // Expired reads as absent rather than as a distinct state: a caller learns it
  // must obtain a new token either way, and the two answers differ only in what
  // they disclose about a token somebody else may be holding.
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;

  // An access token minted for this server must not be accepted by another, and
  // vice versa. NULL means the token predates audience binding - every device
  // token - so it is accepted anywhere, which is what it always meant.
  if (row.resource && resource && row.resource !== resource) return null;

  // Coalesced: verifyToken runs on every authenticated request and this is the
  // same WAL database the capture path writes notes into. A hosted connector
  // polling every few seconds would otherwise contend with a voice note for the
  // write lock, to keep a timestamp that is displayed as a date.
  const last = row.last_used ? Date.parse(row.last_used) : 0;
  if (Date.now() - last > 60_000) {
    db.query("UPDATE tokens SET last_used = ? WHERE id = ?").run(new Date().toISOString(), row.id);
  }

  return {
    id: row.id,
    deviceName: row.device_name,
    ...(row.audience ? { audience: row.audience } : {}),
    ...(row.caps ? { caps: row.caps } : {}),
    ...(row.read_view ? { readView: row.read_view } : {}),
    ...(row.write_view ? { writeView: row.write_view } : {}),
    ...(row.client_id ? { clientId: row.client_id } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  };
}

/**
 * Rotate an access token and its refresh token together, in place.
 *
 * One row per connection for its whole life, so `revokeToken` on the id the
 * owner sees in Credentials kills the access token and the refresh family in one
 * statement - there is no second table holding a credential that outlives it.
 *
 * Returns null for a refresh token that is unknown, already rotated, or belongs
 * to a revoked row. The caller answers all three as `invalid_grant`, because
 * telling them apart tells a holder of a stolen refresh token which it is.
 */
export function rotateRefresh(
  db: Database,
  refreshToken: string,
  ttlMs: number,
): { id: string; accessToken: string; refreshToken: string; expiresAt: string } | null {
  const row = db
    .query("SELECT id FROM tokens WHERE refresh_hash = ? AND revoked_at IS NULL")
    .get(sha256(refreshToken)) as { id: string } | null;
  if (!row) return null;

  const accessToken = randomBytes(32).toString("hex");
  const nextRefresh = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const r = db
    .query("UPDATE tokens SET hash = ?, refresh_hash = ?, expires_at = ? WHERE id = ? AND refresh_hash = ?")
    .run(sha256(accessToken), sha256(nextRefresh), expiresAt, row.id, sha256(refreshToken));
  if (r.changes !== 1) return null;
  return { id: row.id, accessToken, refreshToken: nextRefresh, expiresAt };
}

/** Revoke by either half of the pair, for RFC 7009. */
export function revokeByToken(db: Database, token: string): boolean {
  const now = new Date().toISOString();
  const r = db
    .query("UPDATE tokens SET revoked_at = ? WHERE (hash = ? OR refresh_hash = ?) AND revoked_at IS NULL")
    .run(now, sha256(token), sha256(token));
  return r.changes > 0;
}

export function revokeToken(db: Database, id: string): boolean {
  const r = db.query("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id);
  return r.changes > 0;
}

export function listTokens(db: Database): TokenRow[] {
  return db
    .query("SELECT id, device_name, created_at, last_used, audience, caps, read_view, write_view, expires_at, client_id FROM tokens WHERE revoked_at IS NULL ORDER BY created_at")
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
const MAX_PAIRING_ATTEMPTS = 8;
const PAIRING_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;

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
  | { ok: false; reason: "unknown" | "expired" | "used" | "locked" };

function pairingAllowed(db: Database, caller: string): boolean {
  const row = db.query("SELECT attempts, window_at, locked_at FROM pairing_attempts WHERE caller = ?")
    .get(caller) as { attempts: number; window_at: string; locked_at: string | null } | null;
  if (!row) return true;
  if (row.locked_at) return false;
  if (Date.now() - Date.parse(row.window_at) >= PAIRING_ATTEMPT_WINDOW_MS) {
    db.query("DELETE FROM pairing_attempts WHERE caller = ?").run(caller);
    return true;
  }
  return row.attempts < MAX_PAIRING_ATTEMPTS;
}

function recordPairingFailure(db: Database, caller: string): void {
  const now = new Date().toISOString();
  const row = db.query("SELECT attempts, window_at FROM pairing_attempts WHERE caller = ?")
    .get(caller) as { attempts: number; window_at: string } | null;
  if (!row || Date.now() - Date.parse(row.window_at) >= PAIRING_ATTEMPT_WINDOW_MS) {
    db.query("INSERT INTO pairing_attempts (caller, attempts, window_at) VALUES (?, 1, ?) ON CONFLICT(caller) DO UPDATE SET attempts = 1, window_at = excluded.window_at, locked_at = NULL")
      .run(caller, now);
    return;
  }
  const attempts = row.attempts + 1;
  db.query("UPDATE pairing_attempts SET attempts = ?, locked_at = ? WHERE caller = ?")
    .run(attempts, attempts >= MAX_PAIRING_ATTEMPTS ? now : null, caller);
}

export function redeemPairingCode(db: Database, code: string, deviceName: string, caller = "unknown"): PairResult {
  if (!pairingAllowed(db, caller)) return { ok: false, reason: "locked" };
  const row = db.query("SELECT code, expires_at, used_at, attempts, locked_at FROM pairing_codes WHERE code = ?")
    .get(code) as { code: string; expires_at: string; used_at: string | null; attempts: number; locked_at: string | null } | null;

  if (!row) {
    recordPairingFailure(db, caller);
    return { ok: false, reason: "unknown" };
  }
  if (row.used_at) {
    recordPairingFailure(db, caller);
    return { ok: false, reason: "used" };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    recordPairingFailure(db, caller);
    return { ok: false, reason: "expired" };
  }
  if (row.locked_at) return { ok: false, reason: "locked" };

  // A redemption request necessarily reveals which code is being attempted.
  // Count every failed use of an extant code and permanently lock it before a
  // six-digit code can be exhaustively guessed within its short lifetime.
  if (!/^\d{6}$/.test(code)) {
    recordPairingFailure(db, caller);
    return { ok: false, reason: "unknown" };
  }

  db.query("UPDATE pairing_codes SET used_at = ? WHERE code = ?").run(new Date().toISOString(), code);
  db.query("DELETE FROM pairing_attempts WHERE caller = ?").run(caller);
  const { id, token } = mintToken(db, deviceName);
  return { ok: true, id, token };
}

export function sweepExpiredCodes(db: Database): void {
  db.query("DELETE FROM pairing_codes WHERE expires_at < ?").run(new Date().toISOString());
  db.query("DELETE FROM pairing_attempts WHERE window_at < ?")
    .run(new Date(Date.now() - PAIRING_ATTEMPT_WINDOW_MS).toISOString());
}
