import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { Vault } from "./vault.ts";
import { Stt } from "./stt.ts";
import { toWav16k, wavSeconds } from "./audio.ts";
import { resolveCaptureTime } from "./capture-time.ts";
import * as idem from "./idempotency.ts";
import {
  adminTokenOk, verifyToken, mintToken, listTokens, revokeToken,
  newPairingCode, redeemPairingCode, sweepExpiredCodes,
} from "./auth.ts";
import { ConsoleNotifier, NtfyNotifier, safeNotify, type Notifier } from "./notify.ts";
import { scheduleDigest, recordCapture, recordFailure, buildDigest, renderDigest } from "./digest.ts";

export const VERSION = "0.1.0";
/** Clients older than this are refused rather than left to fail mysteriously. */
export const MIN_CLIENT = "0.1.0";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SECONDS = 300;
const MAX_INFLIGHT = 2;

const config = loadConfig();
const db = openDb(join(config.dataDir, "tama.db"));
const vault = new Vault(config.vault.path, config.vault.inbox, config.safety.dryRun, config.safety.allowUnbackedVault);
const stt = new Stt(config.stt.url);

const notifier: Notifier =
  config.notify.provider === "ntfy"
    ? new NtfyNotifier(config.notify.ntfy.url, config.notify.ntfy.topic, config.notify.ntfy.token)
    : new ConsoleNotifier();

await vault.preflight();
sweepExpiredCodes(db);
idem.sweep(db);

if (!(await stt.health())) {
  recordFailure(db, { kind: "stt-down", detail: `unreachable at ${config.stt.url} at startup` });
  safeNotify(notifier, {
    level: "error",
    title: "Tama: speech-to-text is down",
    message: `whisper unreachable at ${config.stt.url}. Captures will fail until it is up.`,
  });
}

let inflight = 0;
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b, null, 2) + "\n", { status: s, headers: { "content-type": "application/json" } });

// ---------------------------------------------------------------- capture

async function doCapture(req: Request, device: string): Promise<Response> {
  const started = performance.now();
  const ct = req.headers.get("content-type") ?? "";

  let text: string;
  let seconds = 0;
  let timeInput = {
    capturedAt: req.headers.get("x-tama-captured-at"),
    capturedAgeMs: req.headers.get("x-tama-captured-age-ms"),
  };

  if (ct.includes("application/json")) {
    const body = (await req.json()) as { text?: string; capturedAt?: string; capturedAgeMs?: number };
    if (!body.text?.trim()) return json({ error: "text is required" }, 400);
    text = body.text;
    timeInput = {
      capturedAt: body.capturedAt ?? timeInput.capturedAt,
      capturedAgeMs: (body.capturedAgeMs as unknown as string) ?? timeInput.capturedAgeMs,
    };
  } else {
    let bytes: Uint8Array;
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file") ?? form.get("audio");
      if (!(file instanceof Blob)) return json({ error: "no file field in form" }, 400);
      if (file.size > MAX_UPLOAD_BYTES) return json({ error: "upload too large" }, 413);
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const buf = await req.arrayBuffer();
      if (buf.byteLength === 0) return json({ error: "empty body" }, 400);
      if (buf.byteLength > MAX_UPLOAD_BYTES) return json({ error: "upload too large" }, 413);
      bytes = new Uint8Array(buf);
    }
    const wav = await toWav16k(bytes, MAX_SECONDS);
    seconds = wavSeconds(wav);
    text = await stt.transcribe(wav);
  }

  if (!text.trim()) {
    const detail = `${seconds.toFixed(1)}s of audio produced no words. mic muted, too quiet, or nothing said`;
    recordFailure(db, { kind: "empty-transcript", detail, source: device });
    safeNotify(notifier, {
      level: "warn",
      title: "Tama: nothing was heard",
      message: `${device} sent ${seconds.toFixed(1)}s of audio and no words came out. Nothing was written.`,
    });
    return json({ error: "transcript was empty, nothing written", reason: "no-speech-detected" }, 422);
  }

  const t = resolveCaptureTime(timeInput);
  const result = await vault.capture({ text, source: device, at: t.at });
  const ms = Math.round(performance.now() - started);

  recordCapture(db, {
    id: crypto.randomUUID(),
    capturedAt: t.at,
    notePath: result.relPath,
    words: text.trim().split(/\s+/).length,
    audioSecs: seconds,
    source: device,
  });

  console.log(`capture ${result.relPath} ${result.bytes}B ${seconds.toFixed(1)}s ${ms}ms [${t.basis}] <${device}>`);

  // The delivery confirmation. This response IS the "did it go through" answer,
  // and the device drives its screen straight off it.
  return json({
    ok: true,
    path: result.relPath,
    text,
    bytes: result.bytes,
    audioSeconds: Number(seconds.toFixed(1)),
    capturedAt: t.at.toISOString(),
    timeBasis: t.basis,
    ...(t.warning ? { warning: t.warning } : {}),
    ms,
  });
}

// ---------------------------------------------------------------- routes

const server = Bun.serve({
  port: config.server.port,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url);
    const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer /i, "");

    if (url.pathname === "/health") {
      return json({
        ok: true,
        version: VERSION,
        minClient: MIN_CLIENT,
        stt: await stt.health(),
        vault: config.vault.path,
        notify: notifier.name,
      });
    }

    // Redeem a pairing code. Unauthenticated by design: the code IS the credential.
    if (url.pathname === "/pair" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { code?: string; deviceName?: string };
      if (!b.code) return json({ error: "code is required" }, 400);
      const r = redeemPairingCode(db, String(b.code), b.deviceName ?? "unnamed device");
      if (!r.ok) return json({ error: `pairing code ${r.reason}` }, 403);
      safeNotify(notifier, { level: "info", title: "Tama: new device paired", message: b.deviceName ?? "unnamed device" });
      return json({ ok: true, id: r.id, token: r.token, note: "store this now, it is not shown again" });
    }

    const isAdmin = adminTokenOk(bearer, config.server.adminToken);
    const device = isAdmin ? { id: "admin", deviceName: "admin" } : verifyToken(db, bearer);
    if (!device) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/capture" && req.method === "POST") {
      const key = req.headers.get("idempotency-key");
      if (key) {
        const c = idem.claim(db, key);
        if (c.state === "duplicate") return json(c.response as object);
        if (c.state === "in-flight") return json({ error: "already in flight" }, 409);
      }
      if (inflight >= MAX_INFLIGHT) {
        if (key) idem.release(db, key);
        return json({ error: "busy, retry shortly" }, 503);
      }
      inflight++;
      try {
        const res = await doCapture(req, device.deviceName);
        if (key && res.status === 200) idem.complete(db, key, await res.clone().json());
        else if (key) idem.release(db, key);
        return res;
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        if (key) idem.release(db, key);
        recordFailure(db, { kind: "capture-failed", detail, source: device.deviceName });
        safeNotify(notifier, {
          level: "error",
          title: "Tama: a capture failed",
          message: `${device.deviceName}: ${detail.slice(0, 160)}`,
        });
        console.error("capture failed:", e);
        return json({ error: detail }, 500);
      } finally {
        inflight--;
      }
    }

    // --- admin only ---
    if (!isAdmin) return json({ error: "admin token required" }, 403);

    if (url.pathname === "/pair/code" && req.method === "POST") {
      const { code, expiresAt } = newPairingCode(db);
      console.log(`pairing code ${code} (expires ${expiresAt})`);
      return json({ code, expiresAt });
    }
    if (url.pathname === "/tokens" && req.method === "GET") return json({ tokens: listTokens(db) });
    if (url.pathname === "/tokens" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { deviceName?: string };
      const t = mintToken(db, b.deviceName ?? "unnamed device");
      return json({ ...t, note: "store this now, it is not shown again" });
    }
    if (url.pathname.startsWith("/tokens/") && req.method === "DELETE") {
      const id = url.pathname.split("/")[2] ?? "";
      return revokeToken(db, id) ? json({ ok: true, revoked: id }) : json({ error: "not found" }, 404);
    }
    if (url.pathname === "/digest" && req.method === "GET") {
      const d = buildDigest(db, new Date(Date.now() - 86_400_000).toISOString());
      return json({ digest: d, rendered: renderDigest(d) });
    }

    return json({ error: "not found" }, 404);
  },
});

const stopDigest = scheduleDigest(db, notifier, config.notify.digestAt);
setInterval(() => { sweepExpiredCodes(db); idem.sweep(db); }, 3600_000).unref();

console.log(`tama-server ${VERSION}   http://127.0.0.1:${server.port}`);
console.log(`  vault   ${config.vault.path} -> ${config.vault.inbox}/`);
console.log(`  stt     ${config.stt.url}`);
console.log(`  notify  ${notifier.name}, digest at ${config.notify.digestAt}`);
if (config.safety.dryRun) console.log("  DRY RUN - nothing will be written");

process.on("SIGINT", () => { stopDigest(); db.close(); process.exit(0); });
