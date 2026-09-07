import { join } from "node:path";
import { loadConfig, configPathFromArgs } from "./config.ts";
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
import { GrepRetriever } from "./retrieval.ts";
import { makeLlm, type Llm } from "./llm.ts";
import { ask, askOnce } from "./ask.ts";
import { WhatsAppIntegration, whatsappSource } from "./whatsapp.ts";
import { renderPairPage, candidateOrigins } from "./pair-page.ts";
import { tama, red, grey, green, orange, amber } from "./ui.ts";

export const VERSION = "0.1.0";
/** Clients older than this are refused rather than left to fail mysteriously. */
export const MIN_CLIENT = "0.1.0";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SECONDS = 300;
const MAX_INFLIGHT = 2;

const config = loadConfig(configPathFromArgs(Bun.argv));
const db = openDb(join(config.dataDir, "tama.db"));
const vault = new Vault(config.vault.path, config.vault.inbox, config.safety.dryRun, config.safety.allowUnbackedVault);
const stt = new Stt(config.stt);

const notifier: Notifier =
  config.notify.provider === "ntfy"
    ? new NtfyNotifier(config.notify.ntfy.url, config.notify.ntfy.topic, config.notify.ntfy.token)
    : new ConsoleNotifier();

await vault.preflight();
sweepExpiredCodes(db);
idem.sweep(db);

if (!(await stt.health())) {
  recordFailure(db, { kind: "stt-down", detail: `unreachable at ${stt.endpoint} at startup` });
  safeNotify(notifier, {
    level: "error",
    title: "Tama: speech-to-text is down",
    message: `transcription unreachable at ${stt.endpoint}. Captures will fail until it is up.`,
  });
}

// Retrieval reads the vault directly and needs no model, so it exists whether or
// not anyone configured an LLM. The LLM is the optional half.
const retriever = new GrepRetriever(config.vault.path);
let llm: Llm | null = null;
if (config.ask) {
  try {
    llm =
      config.ask.provider === "anthropic"
        ? makeLlm({ provider: "anthropic", apiKey: config.ask.apiKey, model: config.ask.model })
        : makeLlm({
            provider: "openai-compatible",
            baseUrl: config.ask.baseUrl!,
            apiKey: config.ask.apiKey,
            model: config.ask.model,
          });
    console.log(`${grey("  ask    ")} ${llm.name}`);
  } catch (e) {
    // A broken ask config must not take capture down with it. Capture is the
    // free tier and has no dependency on any of this.
    console.error(`ask disabled: ${e instanceof Error ? e.message : String(e)}`);
    llm = null;
  }
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
    const declaredLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) {
      return json({ error: "upload too large" }, 413);
    }
    const raw = await req.arrayBuffer();
    if (raw.byteLength > MAX_UPLOAD_BYTES) return json({ error: "upload too large" }, 413);
    let body: { text?: string; capturedAt?: string; capturedAgeMs?: number };
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
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
    // DEBUG-TEMP: dump what the device actually sent so the audio itself can be
    // inspected when a transcript comes back empty. Remove once bring-up is done.
    if (process.env.TAMA_DUMP_AUDIO) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await Bun.write(`${process.env.TAMA_DUMP_AUDIO}/${stamp}-${device}-raw.bin`, bytes);
      await Bun.write(`${process.env.TAMA_DUMP_AUDIO}/${stamp}-${device}-ffmpeg.wav`, wav);
      console.log(`${grey("[dump]")} ${bytes.byteLength}B raw -> ${wav.byteLength}B wav (${seconds.toFixed(1)}s)`);
    }
    text = await stt.transcribe(wav);
  }

  if (!text.trim()) {
    const detail = `${seconds.toFixed(1)}s of audio produced no words. mic muted, too quiet, or nothing said`;
    recordFailure(db, { kind: "empty-transcript", detail, source: device });
    safeNotify(notifier, {
      level: "warn",
      title: "Tama: your twin heard nothing",
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

  console.log(`${green("capture")} ${result.relPath} ${grey(`${result.bytes}B ${seconds.toFixed(1)}s ${ms}ms [${t.basis}] <${device}>`)}`);

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

type CaptureDevice = { id: string; deviceName: string };

/** Shared delivery semantics for native clients and the WhatsApp adapter. */
async function runCapture(req: Request, device: CaptureDevice, key: string | null): Promise<Response> {
  if (key) {
    const c = idem.claim(db, device.id, key);
    if (c.state === "duplicate") return json(c.response as object);
    if (c.state === "in-flight") {
      const w = await idem.waitForCompletion(db, device.id, key);
      if (w.state === "done") return json(w.response as object);
      return json({ error: "busy, retry shortly" }, 503);
    }
  }
  if (inflight >= MAX_INFLIGHT) {
    if (key) idem.release(db, device.id, key);
    return json({ error: "busy, retry shortly" }, 503);
  }
  inflight++;
  try {
    const res = await doCapture(req, device.deviceName);
    if (key && res.status === 200) idem.complete(db, device.id, key, await res.clone().json());
    else if (key) idem.release(db, device.id, key);
    return res;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (key) idem.release(db, device.id, key);
    recordFailure(db, { kind: "capture-failed", detail, source: device.deviceName });
    safeNotify(notifier, {
      level: "error",
      title: "Tama: your twin did not remember that",
      message: `${device.deviceName}: ${detail.slice(0, 160)}`,
    });
    console.error("capture failed:", e);
    return json({ error: detail }, 500);
  } finally {
    inflight--;
  }
}

const whatsapp = config.whatsapp
  ? new WhatsAppIntegration({
      db,
      config: config.whatsapp,
      async capture(input) {
        const source = whatsappSource(input.sender, config.whatsapp!.appSecret);
        const req = new Request("http://tama.local/capture", {
          method: "POST",
          headers: {
            "content-type": input.mimeType,
            "x-tama-captured-at": input.capturedAt,
          },
          body: new Blob([input.audio as unknown as BlobPart], { type: input.mimeType }),
        });
        const res = await runCapture(req, { id: source, deviceName: source }, input.messageId);
        const body = await res.json() as { path?: string; error?: string; reason?: string };
        if (res.ok) return `Saved to your second brain.\n${body.path ?? "Capture complete"}`;
        if (res.status === 422) return "I couldn't hear any speech in that voice note, so nothing was saved.";
        if (res.status === 413) return "That voice note is too large for Tama (25 MB maximum), so nothing was saved.";
        if (res.status < 500) return `I couldn't save that voice note: ${body.error ?? `HTTP ${res.status}`}`;
        throw new Error(body.error ?? `capture HTTP ${res.status}`);
      },
      async ask(input) {
        if (!llm) return "Ask is not configured on this Tama server yet. Voice notes still work.";
        const started = performance.now();
        const result = await askOnce({
          question: input.question,
          retriever,
          llm,
          maxChunks: config.ask?.maxChunks,
        });
        const ms = Math.round(performance.now() - started);
        console.log(`${orange("ask")} ${grey(`-> ${result.sources.length} sources ${ms}ms <${whatsappSource(input.sender, config.whatsapp!.appSecret)}>`)} `);
        return result.answer;
      },
      onError(message) {
        console.error(message);
        recordFailure(db, { kind: "whatsapp-failed", detail: message });
      },
    })
  : null;

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
        notify: notifier.name,
        // Advertised so a client can hide or show an ask affordance instead of
        // discovering the answer by getting a 501 mid-question.
        ask: llm ? { available: true, provider: llm.name } : { available: false },
        whatsapp: { available: Boolean(whatsapp) },
      });
    }

    // Meta authenticates this route with its verification token (GET) and an
    // HMAC over the exact request bytes (POST), not a Tama bearer token.
    if (url.pathname === "/webhooks/whatsapp") {
      if (!whatsapp) return json({ error: "WhatsApp is not configured" }, 404);
      return whatsapp.handle(req);
    }

    // The pairing page. Admin-only, because the code it prints is a credential
    // and anyone who can mint one can pair themselves into the vault. A browser
    // cannot set an Authorization header on a plain navigation, so the admin
    // token is accepted in the query string here and nowhere else; the page
    // sends no referrer and is never cached.
    if (url.pathname === "/pair" && req.method === "GET") {
      const given = bearer || url.searchParams.get("token") || "";
      if (!adminTokenOk(given, config.server.adminToken)) {
        return new Response("admin token required\n", {
          status: 401,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const { code, expiresAt } = newPairingCode(db);
      const html = renderPairPage({
        code,
        expiresAt,
        origins: candidateOrigins({
          host: req.headers.get("host"),
          protocol: url.protocol,
          port: config.server.port,
        }),
        version: VERSION,
      });
      console.log(`${grey("pairing page")} ${red(code)} ${grey(`(expires ${expiresAt})`)}`);
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-frame-options": "DENY",
          "content-security-policy":
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      });
    }

    // Redeem a pairing code. Unauthenticated by design: the code IS the credential.
    if (url.pathname === "/pair" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { code?: string; deviceName?: string };
      if (!b.code) return json({ error: "code is required" }, 400);
      const caller = server.requestIP(req)?.address ?? "unknown";
      const r = redeemPairingCode(db, String(b.code), b.deviceName ?? "unnamed device", caller);
      if (!r.ok) return json({ error: `pairing code ${r.reason}` }, 403);
      safeNotify(notifier, { level: "info", title: "Tama: your twin has a new voice", message: b.deviceName ?? "unnamed device" });
      return json({ ok: true, id: r.id, token: r.token, note: "store this now, it is not shown again" });
    }

    const isAdmin = adminTokenOk(bearer, config.server.adminToken);
    const device = isAdmin ? { id: "admin", deviceName: "admin" } : verifyToken(db, bearer);
    if (!device) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/capture" && req.method === "POST") {
      const key = req.headers.get("idempotency-key");
      return runCapture(req, device, key);
    }

    // Ask sits behind the same device token as capture. No new auth surface:
    // anything that can write to the vault can already read it back.
    if (url.pathname === "/ask" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { question?: string; stream?: boolean };
      const question = (b.question ?? "").trim();
      if (!question) return json({ error: "question is required" }, 400);

      // Retrieval works with no model configured, so say which half is missing
      // rather than pretending the whole endpoint does not exist.
      if (!llm) {
        const chunks = await retriever.search(question, config.ask?.maxChunks ?? 8);
        return json(
          {
            error: "no language model configured, so questions cannot be answered",
            hint: "add an \"ask\" block to tama.config.json (see tama.config.example.json)",
            retrievalWorks: true,
            wouldHaveUsed: chunks.map((c) => ({ path: c.path, score: c.score })),
          },
          501,
        );
      }

      if (b.stream) {
        // Server-sent events, one JSON object per event, so a client can show
        // sources immediately and text as it arrives.
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            try {
              for await (const ev of ask({ question, retriever, llm: llm!, maxChunks: config.ask?.maxChunks })) {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
              }
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              controller.enqueue(enc.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`));
            } finally {
              controller.close();
            }
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        });
      }

      const started = performance.now();
      let answer = "";
      let sources: Array<{ path: string; score: number }> = [];
      for await (const ev of ask({ question, retriever, llm, maxChunks: config.ask?.maxChunks })) {
        if (ev.type === "sources") sources = ev.sources;
        else if (ev.type === "done") answer = ev.answer;
        else if (ev.type === "error") {
          console.error("ask failed:", ev.message);
          return json({ error: ev.message }, 502);
        }
      }
      const ms = Math.round(performance.now() - started);
      console.log(`${orange("ask")} "${question.slice(0, 60)}" ${grey(`-> ${sources.length} sources ${ms}ms <${device.deviceName}>`)}`);
      return json({ ok: true, question, answer, sources, ms });
    }

    // --- admin only ---
    if (!isAdmin) return json({ error: "admin token required" }, 403);

    if (url.pathname === "/pair/code" && req.method === "POST") {
      const { code, expiresAt } = newPairingCode(db);
      console.log(`${grey("pairing code")} ${red(code)} ${grey(`(expires ${expiresAt})`)}`);
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
whatsapp?.start();
setInterval(() => { sweepExpiredCodes(db); idem.sweep(db); }, 3600_000).unref();

console.log(`${tama("tama-server")} ${grey(VERSION)}   http://127.0.0.1:${server.port}`);
console.log(`${grey("  vault  ")} ${config.vault.path} -> ${config.vault.inbox}/`);
console.log(`${grey("  stt    ")} ${config.stt.url}${config.stt.model ? grey(` (${config.stt.model})`) : ""}`);
console.log(`${grey("  notify ")} ${notifier.name}, digest at ${config.notify.digestAt}`);
if (whatsapp) {
  const callback = config.whatsapp!.publicBaseUrl
    ? `${config.whatsapp!.publicBaseUrl}/webhooks/whatsapp`
    : "/webhooks/whatsapp";
  console.log(`${grey("  whatsapp")} ${callback} (${config.whatsapp!.allowedFrom.length} allowed sender${config.whatsapp!.allowedFrom.length === 1 ? "" : "s"})`);
}
if (config.safety.dryRun) console.log(amber("  DRY RUN - nothing will be written"));

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  stopDigest();
  whatsapp?.stop();
  db.close();
  server.stop(true);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
