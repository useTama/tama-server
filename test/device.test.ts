import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { resolveCaptureTime, MAX_AGE_MS } from "../src/capture-time.ts";
import * as idem from "../src/idempotency.ts";
import { mintToken, verifyToken, revokeToken, newPairingCode, redeemPairingCode } from "../src/auth.ts";
import { buildDigest, renderDigest, recordCapture, recordFailure } from "../src/digest.ts";
import type { Database } from "bun:sqlite";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tama-db-"));
  db = openDb(join(dir, "t.db"));
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// ---- capture time: the ESP32 has no RTC ----------------------------------

test("a device with no clock can still date a note, via age", () => {
  const now = new Date("2026-08-19T09:00:00Z");
  const r = resolveCaptureTime({ capturedAgeMs: 10 * 3600 * 1000 }, now);
  expect(r.basis).toBe("client-age");
  expect(r.at.toISOString()).toBe("2026-08-18T23:00:00.000Z"); // 11pm the night before
});

test("a client with a real clock sends an absolute time", () => {
  const now = new Date("2026-08-19T09:00:00Z");
  const r = resolveCaptureTime({ capturedAt: "2026-08-18T23:00:00Z" }, now);
  expect(r.basis).toBe("client-absolute");
  expect(r.at.toISOString()).toBe("2026-08-18T23:00:00.000Z");
});

test("age wins over absolute, because a device that sends both trusts its own more", () => {
  const now = new Date("2026-08-19T09:00:00Z");
  const r = resolveCaptureTime({ capturedAt: "2020-01-01T00:00:00Z", capturedAgeMs: 1000 }, now);
  expect(r.basis).toBe("client-age");
});

test("a wrong clock is rejected, not trusted", () => {
  const now = new Date("2026-08-19T09:00:00Z");
  const future = resolveCaptureTime({ capturedAt: "2030-01-01T00:00:00Z" }, now);
  expect(future.basis).toBe("server-clock");
  expect(future.warning).toMatch(/future/);

  const ancient = resolveCaptureTime({ capturedAgeMs: MAX_AGE_MS + 1 }, now);
  expect(ancient.basis).toBe("server-clock");
  expect(ancient.warning).toMatch(/30 days/);

  const junk = resolveCaptureTime({ capturedAt: "not a date" }, now);
  expect(junk.basis).toBe("server-clock");
});

test("no client opinion falls back to the server clock", () => {
  const now = new Date("2026-08-19T09:00:00Z");
  expect(resolveCaptureTime({}, now).basis).toBe("server-clock");
});

// ---- idempotency: the device retries from flash --------------------------

test("a retry replays the original result instead of writing twice", () => {
  expect(idem.claim(db, "k1").state).toBe("fresh");
  idem.complete(db, "k1", { ok: true, path: "Inbox/a.md" });

  const again = idem.claim(db, "k1");
  expect(again.state).toBe("duplicate");
  if (again.state === "duplicate") expect(again.response).toEqual({ ok: true, path: "Inbox/a.md" });
});

test("two simultaneous retries do not both proceed", () => {
  expect(idem.claim(db, "k2").state).toBe("fresh");
  expect(idem.claim(db, "k2").state).toBe("in-flight");
});

test("a failed capture releases the key so a retry genuinely retries", () => {
  expect(idem.claim(db, "k3").state).toBe("fresh");
  idem.release(db, "k3");
  expect(idem.claim(db, "k3").state).toBe("fresh");
});

// ---- per-device tokens ----------------------------------------------------

test("a token authenticates, and revoking one does not affect the others", () => {
  const a = mintToken(db, "cheeko-01");
  const b = mintToken(db, "cheeko-02");

  expect(verifyToken(db, a.token)?.deviceName).toBe("cheeko-01");
  expect(verifyToken(db, b.token)?.deviceName).toBe("cheeko-02");

  expect(revokeToken(db, a.id)).toBe(true);
  expect(verifyToken(db, a.token)).toBeNull();
  expect(verifyToken(db, b.token)?.deviceName).toBe("cheeko-02");
});

test("tokens are not stored in the clear", () => {
  const { token } = mintToken(db, "cheeko-01");
  const rows = db.query("SELECT hash FROM tokens").all() as { hash: string }[];
  expect(rows[0]!.hash).not.toBe(token);
  expect(rows[0]!.hash).toHaveLength(64);
});

test("garbage does not authenticate", () => {
  mintToken(db, "cheeko-01");
  expect(verifyToken(db, "")).toBeNull();
  expect(verifyToken(db, "not-a-token")).toBeNull();
});

// ---- pairing --------------------------------------------------------------

test("a pairing code works exactly once", () => {
  const { code } = newPairingCode(db);
  const first = redeemPairingCode(db, code, "cheeko-01");
  expect(first.ok).toBe(true);

  const second = redeemPairingCode(db, code, "cheeko-02");
  expect(second.ok).toBe(false);
  if (!second.ok) expect(second.reason).toBe("used");
});

test("an unknown code is refused", () => {
  const r = redeemPairingCode(db, "000000", "x");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("unknown");
});

test("an expired code is refused", () => {
  const { code } = newPairingCode(db);
  db.query("UPDATE pairing_codes SET expires_at = ? WHERE code = ?")
    .run(new Date(Date.now() - 1000).toISOString(), code);
  const r = redeemPairingCode(db, code, "x");
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.reason).toBe("expired");
});

// ---- digest, which needs no language model --------------------------------

test("the digest counts what happened and names what broke", () => {
  const now = new Date();
  recordCapture(db, { id: "1", capturedAt: now, notePath: "Inbox/a.md", words: 30, audioSecs: 12, source: "cheeko-01" });
  recordCapture(db, { id: "2", capturedAt: now, notePath: "Inbox/b.md", words: 20, audioSecs: 8, source: "cheeko-01" });
  recordFailure(db, { kind: "stt-down", detail: "whisper unreachable", source: "cheeko-01" });

  const d = buildDigest(db, new Date(Date.now() - 86_400_000).toISOString());
  expect(d.captures).toBe(2);
  expect(d.words).toBe(50);
  expect(d.audioMinutes).toBeCloseTo(0.3, 1);
  expect(d.failures).toHaveLength(1);

  const r = renderDigest(d);
  expect(r.level).toBe("warn");
  expect(r.title).toContain("2 captured");
  expect(r.message).toContain("stt-down");
});

test("a quiet day says so instead of sending an empty digest", () => {
  const d = buildDigest(db, new Date(Date.now() - 86_400_000).toISOString());
  const r = renderDigest(d);
  expect(d.captures).toBe(0);
  expect(r.level).toBe("info");
  expect(r.message).toContain("nothing captured");
});

// ---- whisper returns markers, not emptiness, for silence -------------------

test("a transcript of only non-speech markers counts as silence", async () => {
  const { stripNonSpeech } = await import("../src/stt.ts");
  expect(stripNonSpeech("[BLANK_AUDIO]")).toBe("");
  expect(stripNonSpeech("  [BLANK_AUDIO]  ")).toBe("");
  expect(stripNonSpeech("(silence)")).toBe("");
  expect(stripNonSpeech("[MUSIC] (wind blowing)")).toBe("");
});

test("bracketed text mixed with real words is speech and survives intact", async () => {
  const { stripNonSpeech } = await import("../src/stt.ts");
  expect(stripNonSpeech("order the LiDAR [inaudible] before Friday"))
    .toBe("order the LiDAR [inaudible] before Friday");
  expect(stripNonSpeech("call Smitha (the guide)")).toBe("call Smitha (the guide)");
});
