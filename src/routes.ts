/**
 * Every HTTP route, as a function of its dependencies.
 *
 * Split out of index.ts so the routes can be tested. index.ts built its
 * singletons at module scope, which meant importing it started a server and
 * bound a port - so the only testable things were the modules underneath, and
 * the wiring above them had no tests at all. The audience resolution, the write
 * refusal for scoped tokens, the idempotency claim and release, the withheld
 * sources: all of it lived in a closure nothing could reach.
 *
 * `createRoutes` takes what it needs and returns a handler. index.ts is now
 * only the process: load the config, construct the singletons, schedule the
 * digest, serve.
 *
 * `config` is passed by reference on purpose. index.ts reloads audiences and
 * views into that same object when the file changes, and the routes read them
 * per request, so a reload is visible here without re-creating anything.
 */

import type { Config } from "./config.ts";
import { resolveSpeaker } from "./config.ts";
import type { Database } from "bun:sqlite";
import { Vault } from "./vault.ts";
import { Stt } from "./stt.ts";
import { toWav16k, wavSeconds } from "./audio.ts";
import { resolveCaptureTime } from "./capture-time.ts";
import { CaptureError } from "./capture-error.ts";
import { MIN_CLIENT, belowMinimum, describeClient, parseClientVersion } from "./client-version.ts";
import { mentionedDates, recordDates } from "./dates.ts";
import { findAsk, recordAsk, recordFeedback } from "./feedback.ts";
import * as idem from "./idempotency.ts";
import {
  adminTokenOk, verifyToken, mintToken, listTokens, revokeToken,
  newPairingCode, redeemPairingCode, sweepExpiredCodes,
} from "./auth.ts";
import { safeNotify, type Notifier } from "./notify.ts";
import { recordCapture, recordFailure, buildDigest, renderDigest } from "./digest.ts";
import type { Retriever } from "./retrieval.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS, spendLabel, type Llm } from "./llm.ts";
import { ask, askOnce, parseSurface, type PromptOptions } from "./ask.ts";
import { resolveView, type View } from "./views.ts";
import { asMessages, recall, remember, searchQuery, summarise, type Turn } from "./memory.ts";
import { summariseSession } from "./session-summary.ts";
import { appendSession } from "./session.ts";
import { handleMcp, MCP_TOOL_NAMES } from "./mcp.ts";
import { WhatsAppIntegration, whatsappSource } from "./whatsapp.ts";
import { renderPairPage, candidateOrigins, forwardedProtocol } from "./pair-page.ts";
import { tama, red, grey, green, orange, amber } from "./ui.ts";

export const VERSION = "0.1.0";
// Re-exported from its own module so /health below and any importer keep the
// same name. The comment that used to live here claimed clients older than
// this were refused, which nothing did; client-version.ts is where that claim
// is now true.
export { MIN_CLIENT } from "./client-version.ts";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_SECONDS = 300;
const MAX_INFLIGHT = 2;

export type RouteDeps = {
  /** Mutated in place by index.ts on a config reload; read per request. */
  config: Config;
  db: Database;
  vault: Vault;
  stt: Stt;
  retriever: Retriever;
  llm: Llm | null;
  notifier: Notifier;
  /** Called after a vault write, so the caller can schedule a commit. */
  onWrite: () => void;
  /**
   * Graph API transport for the WhatsApp integration. `WhatsAppIntegration`
   * already takes one; this threads it through so the dependencies built here -
   * capture, ask, and the conversation memory around ask - are reachable from a
   * test without a network. Left undefined in production, which means `fetch`.
   */
  whatsappFetch?: typeof fetch;
};

export type Routes = {
  handle: (req: Request, requestIP?: (r: Request) => string | undefined) => Promise<Response>;
  /** Built here because it needs runCapture, and started by index.ts. */
  whatsapp: WhatsAppIntegration | null;
};

export function createRoutes(deps: RouteDeps): Routes {
  const { config, db, vault, stt, retriever, llm, notifier, onWrite, whatsappFetch } = deps;
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
      title: "Tama: nothing was heard",
      message: `${device} sent ${seconds.toFixed(1)}s of audio and no words came out. Nothing was written.`,
    });
    return json({ error: "transcript was empty, nothing written", reason: "no-speech-detected" }, 422);
  }

  const t = resolveCaptureTime(timeInput);
  // The third of the three things that can fail, and the only one that was
  // still an unclassified 500 with no stage - so `CaptureStage` declared
  // "vault" that nothing ever constructed, and docs/api.md promised a stage on
  // every failed capture while being wrong for the write itself.
  //
  // 500 in every branch, deliberately. A full disk and a read-only mount both
  // fail a retry identically, so 503 would send a client back with the same
  // idempotency key against the same full disk; docs/api.md already defines
  // 500 as the server being set up wrong rather than the request being wrong,
  // which is exactly what these are.
  let result: Awaited<ReturnType<typeof vault.capture>>;
  try {
    result = await vault.capture({ text, source: device, at: t.at });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    const message = e instanceof Error ? e.message : String(e);
    if (code === "ENOSPC") {
      throw new CaptureError(500, "vault", "the disk holding the vault is full", "free space on the server, then send it again");
    }
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
      throw new CaptureError(500, "vault", `the server cannot write to the vault: ${message}`, "check the vault directory's owner and permissions");
    }
    // A path that escapes the vault root is a bug in a caller, not an
    // environment to fix, so it gets the stage and no advice.
    throw new CaptureError(500, "vault", message);
  }
  const ms = Math.round(performance.now() - started);

  // Derived, and never allowed to fail a capture. The note is already written
  // and journalled by this point; losing an extracted date costs a reminder,
  // while throwing here would cost the thought, and the table can be rebuilt
  // from the vault at any time.
  try {
    recordDates(db, result.relPath, mentionedDates(text, t.at));
  } catch (e) {
    console.error("date extraction failed:", e);
  }

  recordCapture(db, {
    id: crypto.randomUUID(),
    capturedAt: t.at,
    notePath: result.relPath,
    words: text.trim().split(/\s+/).length,
    audioSecs: seconds,
    source: device,
  });

  onWrite();
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

type CaptureDevice = { id: string; deviceName: string; audience?: string };

/**
 * What a caller is allowed to see and how the answer should sound, derived from
 * the token rather than from the request.
 *
 * A client naming its own audience could name a different one, and the client
 * most likely to be compromised is the unofficial WhatsApp bridge holding a
 * browser session. So the bridge carries one token per audience and the server
 * looks up the rest.
 *
 * No audience on the token means the owner's own device: everything, cited,
 * which is what every token minted before audiences existed meant.
 */
function audienceProfile(
  name: string | undefined,
): { view?: View; prompt: PromptOptions; identities?: Record<string, string> } {
  const worldName = config.world?.name;
  if (!name) return { prompt: { name: worldName, voice: "friend", cite: true } };

  const audience = config.audiences?.[name];
  if (!audience) {
    // The audience was removed from the config but its token still exists.
    // Failing closed rather than falling back to the owner's view: a stale
    // token must not inherit more access than it had.
    throw new Error(`token names audience ${JSON.stringify(name)}, which is not in the config`);
  }
  return {
    view: resolveView(config.views, audience.view),
    prompt: {
      name: worldName,
      voice: audience.voice,
      voicePrompt: audience.voicePrompt,
      people: audience.people,
      style: audience.length,
      cite: audience.cite,
      onNoMatch: audience.onNoMatch,
      note: audience.note,
    },
    ...(audience.identities ? { identities: audience.identities } : {}),
  };
}

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
    // A classified failure carries its own status and its own fix. Everything
    // that threw in here used to become the same 500, so whisper being down
    // was indistinguishable from a bug in the server, and the reply named
    // neither. See capture-error.ts.
    const known = e instanceof CaptureError ? e : null;
    const detail = known ? known.detail : e instanceof Error ? e.message : String(e);
    const status = known ? known.status : 500;
    if (key) idem.release(db, device.id, key);
    // The stage is in the recorded detail so the failures table says which of
    // ffmpeg, whisper or the vault it was without anyone reading a stack.
    recordFailure(db, {
      kind: "capture-failed",
      detail: known ? `[${known.stage}] ${detail}` : detail,
      source: device.deviceName,
    });
    safeNotify(notifier, {
      level: "error",
      title: "Tama: a capture failed",
      message: `${device.deviceName}: ${detail.slice(0, 160)}`,
    });
    console.error("capture failed:", e);
    return json(known ? { error: detail, stage: known.stage } : { error: detail }, status);
  } finally {
    inflight--;
  }
}

const whatsapp = config.whatsapp
  ? new WhatsAppIntegration({
      db,
      config: config.whatsapp,
      ...(whatsappFetch ? { fetch: whatsappFetch } : {}),
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

        // The thread is the keyed pseudonym, not the phone number. Two reasons.
        //
        // A conversation outlives its inbox row - drain() blanks `sender` the
        // moment a reply is sent, precisely so a number does not sit in the
        // database - and putting the raw number in conversation_turns would
        // undo that in a table nothing ever wipes.
        //
        // It also cannot collide with a paired device's thread, because /ask
        // namespaces those as "<audience>:<thread>" and this has no colon.
        //
        // Sender is the whole thread identity because the Cloud API delivers
        // one-to-one messages to a business number: the sender IS the chat.
        const thread = whatsappSource(input.sender, config.whatsapp!.appSecret);
        const memory = recall(db, thread);
        const search = searchQuery(input.question, memory.turns);

        const result = await askOnce({
          question: input.question,
          retriever,
          llm,
          maxChunks: config.ask?.maxChunks,
          prompt: { name: config.world?.name, style: "chat", cite: false },
          history: asMessages(memory.turns),
          summary: memory.summary,
          searchQuery: search,
        });
        const ms = Math.round(performance.now() - started);

        // Only on an answer, and only after one. A failed reply leaves the
        // question unremembered rather than recording a turn that never
        // happened, and summarising is a model call nobody should wait on.
        if (result.answer) {
          remember(db, thread, "user", input.question);
          remember(db, thread, "assistant", result.answer);
          void summarise(db, thread, llm).catch((e) => console.error("summarise failed:", e));
        }

        const carried = `${memory.turns.length ? ` +${memory.turns.length} turns` : ""}${memory.summary ? " +summary" : ""}`;
        console.log(`${orange("ask")} ${grey(`-> ${result.sources.length} sources ${ms}ms${spendLabel(result.usage)}${carried} <${thread}>`)} `);
        return result.answer;
      },
      onError(message) {
        console.error(message);
        recordFailure(db, { kind: "whatsapp-failed", detail: message });
      },
    })
  : null;

// ---------------------------------------------------------------- routes

  /**
   * One request, one response. Takes `requestIP` rather than reaching for the
   * server, so a test can drive this with a plain Request and no live port -
   * which is the whole point of the extraction.
   */
  const handle = async function handle(req: Request, requestIP?: (r: Request) => string | undefined): Promise<Response> {
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
        mcp: { available: true, tools: MCP_TOOL_NAMES.length },
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
          // The proxy's scheme, not this socket's. `tailscale serve` and Caddy
          // both terminate TLS and forward plain http to 127.0.0.1, so
          // `url.protocol` here is "http:" while the name in the Host header
          // only answers https. The QR then encodes an address that cannot
          // work, and a phone scanning it fails with nothing to read.
          //
          // Trusted because it is only ever read on this route, and only to
          // choose a scheme to PRINT. A forged header makes a pairing page
          // offer a URL the forger already controls, which is not a capability
          // they gained by forging it.
          protocol: forwardedProtocol(req) ?? url.protocol,
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
      const caller = requestIP?.(req) ?? "unknown";
      const r = redeemPairingCode(db, String(b.code), b.deviceName ?? "unnamed device", caller);
      if (!r.ok) return json({ error: `pairing code ${r.reason}` }, 403);
      safeNotify(notifier, { level: "info", title: "Tama: new device paired", message: b.deviceName ?? "unnamed device" });
      return json({ ok: true, id: r.id, token: r.token, note: "store this now, it is not shown again" });
    }

    const isAdmin = adminTokenOk(bearer, config.server.adminToken);
    const device: CaptureDevice | null = isAdmin ? { id: "admin", deviceName: "admin" } : verifyToken(db, bearer);
    if (!device) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/capture" && req.method === "POST") {
      /**
       * The version gate, and the reason it lives here rather than inside
       * runCapture.
       *
       * runCapture claims the idempotency key before it does anything else, so
       * a refusal issued from in there would poison the key: the client's
       * correct retry would be answered with the same 426 for as long as the
       * record lives, and a genuinely upgraded client with a queued note could
       * never deliver it.
       *
       * Being at the HTTP dispatch also leaves the in-process WhatsApp path
       * ungated, which is right - it builds its own Request and calls
       * runCapture directly, and its "client" is this same binary. Making the
       * adapter stamp a version would be the server checking itself.
       *
       * /ask is deliberately not gated. A stale client reading its own notes
       * is harmless; a stale one writing them is what MIN_CLIENT is about.
       */
      const client = parseClientVersion(req.headers.get("x-tama-client"));
      if (client && belowMinimum(client.version)) {
        console.error(
          `${orange("capture")} refused ${describeClient(client)}, below the minimum ${MIN_CLIENT} <${device.deviceName}>`,
        );
        return json({
          error: `this client is ${describeClient(client)}, older than the minimum ${MIN_CLIENT} this server supports. update it`,
          minClient: MIN_CLIENT,
        }, 426);
      }
      const key = req.headers.get("idempotency-key");
      return runCapture(req, device, key);
    }

    // The same five capabilities as the routes above, spoken as MCP. Placed
    // after the bearer check so it inherits one auth surface rather than
    // inventing a second: the spec's OAuth mandate is for internet-facing
    // servers, and a personal daemon behind a static token is explicitly
    // sufficient.
    if (url.pathname === "/mcp") {
      let profile: ReturnType<typeof audienceProfile>;
      try {
        profile = audienceProfile(device.audience);
      } catch (e) {
        console.error("mcp refused:", e instanceof Error ? e.message : e);
        return json({ error: "this device is no longer configured" }, 403);
      }
      return handleMcp(req, {
        deviceName: device.deviceName,
        audience: device.audience,
        view: profile.view,
        // An audience reads. A group's token holding a write tool would be the
        // first way a room could put something into somebody's notes.
        mayWrite: !device.audience,
      }, {
        onWrite: onWrite,
        retriever,
        vault,
        db,
        vaultRoot: config.vault.path,
        maxChunks: config.ask?.maxChunks ?? 8,
        worldName: config.world?.name,
      });
    }

    /**
     * "That answer was wrong."
     *
     * The owner's device only. In a group the question is often someone
     * else's message and this record is permanent, where conversation history
     * is not, so an open route would let a stranger both fill the file with
     * other people's words and decide what the eval set gets built from.
     *
     * Nothing is sent anywhere. It appends a line to a file in the data
     * directory, for a person to read and decide what belongs in golden.ts.
     */
    if (url.pathname === "/feedback" && req.method === "POST") {
      if (device.audience) return json({ error: "only the owner's device may rate an answer" }, 403);
      const b = (await req.json().catch(() => ({}))) as {
        thread?: string; askId?: string; verdict?: string; note?: string;
      };

      const verdict = b.verdict === "right" ? "right" : b.verdict === "wrong" ? "wrong" : null;
      if (!verdict) return json({ error: 'verdict must be "wrong" or "right"' }, 400);

      // Namespaced exactly as /ask does it, so a thread means the same thing
      // to both routes and one audience cannot rate another's answers.
      const raw = typeof b.thread === "string" ? b.thread.trim().slice(0, 128) : "";
      if (!raw) return json({ error: "thread is required" }, 400);
      const thread = `${device.audience ?? "owner"}:${raw}`;

      const target = findAsk(db, thread, typeof b.askId === "string" ? b.askId : undefined);
      if (!target) {
        // Distinguished from a bad request: the thread is fine, there is just
        // nothing recent enough to be talking about.
        return json({ error: "no recent answer in that thread to rate" }, 404);
      }

      const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : "";
      await recordFeedback(config.dataDir, {
        at: new Date().toISOString(),
        verdict,
        question: target.question,
        retrieved: target.sources,
        ...(note ? { note } : {}),
      });
      console.log(
        `${orange("feedback")} ${verdict} "${target.question.slice(0, 60)}" ${grey(`${target.sources.length} sources <${device.deviceName}>`)}`,
      );
      return json({ ok: true, recorded: verdict, question: target.question, retrieved: target.sources });
    }

    // Writing at a chosen path is the owner's own device only. An audience
    // reads; it has no business adding to the vault, and a group's token
    // getting a write path would be the first way a room could put something
    // in someone's notes.
    if (url.pathname === "/notes" && req.method === "POST") {
      if (device.audience) return json({ error: "this device may not write notes" }, 403);
      const b = (await req.json().catch(() => ({}))) as { path?: string; text?: string; mode?: string };
      const relPath = String(b.path ?? "").trim();
      const text = String(b.text ?? "");
      if (!relPath) return json({ error: "path is required" }, 400);
      if (!text.trim()) return json({ error: "text is required" }, 400);
      if (Buffer.byteLength(text, "utf8") > MAX_UPLOAD_BYTES) return json({ error: "text too large" }, 413);

      const key = req.headers.get("idempotency-key");
      if (key) {
        const claimed = idem.claim(db, device.id, key);
        if (claimed.state === "duplicate") return json(claimed.response as object);
        if (claimed.state === "in-flight") return json({ error: "busy, retry shortly" }, 503);
      }
      try {
        const result = b.mode === "create"
          ? await vault.importMarkdown(relPath, text)
          : await vault.appendMarkdown(relPath, text);
        const body = {
          ok: true,
          path: result.relPath,
          bytes: result.bytes,
          ...(("created" in result) ? { created: result.created } : {}),
        };
        onWrite();
        console.log(`${green("note")} ${result.relPath} ${grey(`${result.bytes}B ${b.mode === "create" ? "created" : "appended"} <${device.deviceName}>`)}`);
        if (key) idem.complete(db, device.id, key, body);
        return json(body);
      } catch (e) {
        if (key) idem.release(db, device.id, key);
        const detail = e instanceof Error ? e.message : String(e);
        recordFailure(db, { kind: "note-failed", detail, source: device.deviceName });
        console.error("note write failed:", detail);
        // An unsafe path is the caller's mistake, not a server fault.
        return json({ error: detail }, /unsafe|escapes|not a regular file/.test(detail) ? 400 : 500);
      }
    }

    // One append per work session, to one file per project. Sugar over /notes,
    // and the shape is the point: a rendered entry that reads as a diary is
    // what makes "what have I been doing on X" answerable later.
    if (url.pathname === "/sessions" && req.method === "POST") {
      if (device.audience) return json({ error: "this device may not write notes" }, 403);
      const b = (await req.json().catch(() => ({}))) as {
        project?: string;
        summary?: string;
        shipped?: string[];
        learned?: string[];
        next?: string[];
      };
      const project = String(b.project ?? "").trim();
      if (!project) return json({ error: "project is required" }, 400);

      const key = req.headers.get("idempotency-key");
      if (key) {
        const claimed = idem.claim(db, device.id, key);
        if (claimed.state === "duplicate") return json(claimed.response as object);
        if (claimed.state === "in-flight") return json({ error: "busy, retry shortly" }, 503);
      }
      try {
        const asList = (v: unknown) => (Array.isArray(v) ? v.map((i) => String(i)) : undefined);
        const result = await appendSession(vault, {
          project,
          summary: String(b.summary ?? ""),
          shipped: asList(b.shipped),
          learned: asList(b.learned),
          next: asList(b.next),
        });
        const body = { ok: true, ...result };
        onWrite();
        console.log(`${green("session")} ${result.relPath} ${grey(`${result.bytes}B ${result.created ? "started" : "appended"} <${device.deviceName}>`)}`);
        if (key) idem.complete(db, device.id, key, body);
        return json(body);
      } catch (e) {
        if (key) idem.release(db, device.id, key);
        const detail = e instanceof Error ? e.message : String(e);
        recordFailure(db, { kind: "session-failed", detail, source: device.deviceName });
        console.error("session write failed:", detail);
        return json({ error: detail }, /nothing to record|no usable characters|unsafe/.test(detail) ? 400 : 500);
      }
    }

    /**
     * A session's transcript in, an entry in the log or nothing at all.
     *
     * The sibling of `/sessions`, which takes a finished summary. This takes
     * the raw material, because the caller is a `SessionEnd` hook: it fires
     * after the session it belongs to is gone, so it has a transcript and no
     * way to ask a model anything about it.
     *
     * Owner-only, like `/sessions`. A scoped token reads; nothing that reads
     * gets to decide what goes into somebody's engineering log.
     *
     * Answering 200 with `filed: false` rather than an error is the point. A
     * session that reached nothing worth writing down is the common case, and
     * a caller that fires on every session end must be able to tell "there was
     * nothing to say" from "something broke" without parsing a message.
     */
    if (url.pathname === "/sessions/from-transcript" && req.method === "POST") {
      if (device.audience) return json({ error: "this device may not write notes" }, 403);
      if (!llm) {
        return json({
          error: "no language model configured, so a transcript cannot be summarised",
          hint: "add an \"ask\" block to tama.config.json, or have the client call /sessions with a summary it wrote itself",
        }, 501);
      }

      const b = (await req.json().catch(() => ({}))) as {
        project?: string;
        turns?: Array<{ role?: string; text?: string }>;
      };
      const project = String(b.project ?? "").trim();
      if (!project) return json({ error: "project is required" }, 400);
      if (!Array.isArray(b.turns) || b.turns.length === 0) {
        return json({ error: "turns is required: the transcript, oldest first" }, 400);
      }

      // Trimmed again here. The hook already drops tool output and caps what it
      // sends, and a cap that lives only in a client is not a cap: this is the
      // route that spends the owner's money, so it is the route that decides
      // how much.
      //
      // Both ends, never `slice(0, N)`. A real 25MB transcript reduces to ~500
      // conversational turns, so a front slice at 400 silently discarded the
      // last ninety - the outcome, which is the half an entry is actually
      // about. The first turn states the task and the last ones say how it
      // went; the middle is the searching.
      const MAX_TURNS = 400;
      const submitted = b.turns.map((t) => ({
        role: t.role === "assistant" ? ("assistant" as const) : ("user" as const),
        text: String(t.text ?? ""),
      }));
      const turns = submitted.length <= MAX_TURNS
        ? submitted
        : [submitted[0]!, ...submitted.slice(submitted.length - (MAX_TURNS - 1))];

      // The client's session id, so a hook that retries - or a second machine
      // syncing the same session - appends once rather than twice.
      const key = req.headers.get("idempotency-key");
      if (key) {
        const claimed = idem.claim(db, device.id, key);
        if (claimed.state === "duplicate") return json(claimed.response as object);
        if (claimed.state === "in-flight") return json({ error: "busy, retry shortly" }, 503);
      }

      try {
        const result = await summariseSession(llm, { project, turns });
        if (!result.filed) {
          const body = { ok: true, filed: false, reason: result.reason };
          if (key) idem.complete(db, device.id, key, body);
          // Reported even though nothing was written: declining is the common
          // outcome and it still costs a completion, so a log that only shows
          // filed entries understates what this feature spends.
          console.log(`${grey("session")} ${grey(`nothing filed for ${project}:${spendLabel(result.usage)} ${result.reason} <${device.deviceName}>`)}`);
          return json(body);
        }

        const written = await appendSession(vault, result.entry);
        const body = { ok: true, filed: true, ...written, dropped: result.dropped };
        onWrite();
        console.log(
          `${green("session")} ${written.relPath} ` +
            grey(`${written.bytes}B ${written.created ? "started" : "appended"} from ${turns.length} turn${turns.length === 1 ? "" : "s"}${spendLabel(result.usage)} <${device.deviceName}>`),
        );
        if (key) idem.complete(db, device.id, key, body);
        return json(body);
      } catch (e) {
        if (key) idem.release(db, device.id, key);
        const detail = e instanceof Error ? e.message : String(e);
        recordFailure(db, { kind: "session-summary-failed", detail, source: device.deviceName });
        console.error("session summary failed:", detail);
        return json({ error: detail }, /nothing to record|no usable characters|unsafe/.test(detail) ? 400 : 502);
      }
    }

    // Ask sits behind the same device token as capture. No new auth surface:
    // anything that can write to the vault can already read it back.
    if (url.pathname === "/ask" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as {
        question?: string;
        stream?: boolean;
        style?: string;
        speaker?: string;
        speakerIsOwner?: boolean;
        /** An opaque conversation id. One chat, one thread. */
        thread?: string;
        /** Which chat app this is, and this client's own address on it. */
        surface?: unknown;
      };
      const question = (b.question ?? "").trim();
      if (!question) return json({ error: "question is required" }, 400);

      let profile: ReturnType<typeof audienceProfile>;
      try {
        profile = audienceProfile(device.audience);
      } catch (e) {
        console.error("ask refused:", e instanceof Error ? e.message : e);
        return json({ error: "this device is no longer configured" }, 403);
      }
      // The owner may still ask for the chat shape from a chat client; an
      // audience's own length is not overridable, because a scoped chat asking
      // for prose is asking for note paths it was not given.
      if (!device.audience && b.style === "chat") profile.prompt.style = "chat";

      // Which app this is and what number it answers on: knowable only to the
      // client, and previously known to nobody. The model was fielding
      // questions about both by guessing. Validated rather than relayed, since
      // the answer to "what is your number" should not be whatever a client
      // put in a string. Set for an audience too - the bot's own number is
      // already visible to anyone it is talking to.
      const surface = parseSurface(b.surface);
      if (surface) profile.prompt.surface = surface;

      // Asserted by the client, because only the client knows which of a
      // group's participants sent this. That is the same trust the bridge
      // already has for choosing an audience at all, and it cannot widen what
      // the audience reads: the view comes from the token.
      //
      // Resolved to the name the prompt already uses for that person, because
      // the client can only report what WhatsApp told it: a push name, an
      // address-book name, or a bare phone number. Unresolved, the model was
      // given "Who is in this room: Priya, Anand" beside "A message from
      // 919876543210" and nothing joining them, so in a group it could not
      // tell who was talking.
      const speaker = resolveSpeaker(
        typeof b.speaker === "string" ? b.speaker.slice(0, 64) : undefined,
        profile.identities,
      );
      const speakerIsOwner = b.speakerIsOwner === true;

      // Scoped to the token, so two audiences in the same chat cannot read each
      // other's history, and a revoked token's thread is unreachable.
      const thread = typeof b.thread === "string" && b.thread.trim()
        ? `${device.audience ?? "owner"}:${b.thread.trim().slice(0, 128)}`
        : "";
      const memory = thread ? recall(db, thread) : { turns: [] as Turn[] };
      const history = asMessages(memory.turns);
      const search = thread ? searchQuery(question, memory.turns) : question;

      // Retrieval works with no model configured, so say which half is missing
      // rather than pretending the whole endpoint does not exist.
      if (!llm) {
        const chunks = await retriever.search(question, config.ask?.maxChunks ?? 8, profile.view);
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

      // Captured for the stream's closure, which cannot see `device`.
      const audienceOfDevice = device.audience;
      if (b.stream) {
        // Server-sent events, one JSON object per event, so a client can show
        // sources immediately and text as it arrives.
        const streamStarted = performance.now();
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            try {
              for await (const ev of ask({ question, retriever, llm: llm!, maxChunks: config.ask?.maxChunks, view: profile.view, prompt: profile.prompt, speaker, speakerIsOwner, history, summary: memory.summary, searchQuery: search })) {
                controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
                // The streaming half reported nothing, so an answer streamed to
                // a client spent money the log never mentioned - and the buffered
                // half beside it reported every token. Same line, same shape.
                if (ev.type === "done") {
                  const ms = Math.round(performance.now() - streamStarted);
                  console.log(`${orange("ask")} "${question.slice(0, 60)}" ${grey(`-> streamed ${ms}ms${spendLabel(ev.usage)} <${device.deviceName}>`)}`);
                  if (ev.usage?.stopReason === "length") {
                    console.error(
                      `${orange("ask")} answer was truncated at ${config.ask?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS} output tokens. ` +
                        `raise ask.maxTokens, or ask a narrower question`,
                    );
                  }
                }
              }
            } catch (e) {
              const raw = e instanceof Error ? e.message : String(e);
              console.error("ask stream failed:", raw);
              const message = audienceOfDevice ? "the model could not answer that right now" : raw;
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
      let usage: import("./llm.ts").LlmUsage | undefined;
      let sources: Array<{ path: string; score: number }> = [];
      for await (const ev of ask({ question, retriever, llm, maxChunks: config.ask?.maxChunks, view: profile.view, prompt: profile.prompt, speaker, speakerIsOwner, history, summary: memory.summary, searchQuery: search })) {
        if (ev.type === "sources") sources = ev.sources;
        else if (ev.type === "done") {
          answer = ev.answer;
          usage = ev.usage;
        }
        else if (ev.type === "error") {
          console.error("ask failed:", ev.message);
          // A provider's error text is written for whoever runs the server. It
          // names the model, the endpoint, and in OpenRouter's case a URL
          // containing a key identifier - and an audience's reply goes into a
          // room full of other people. This one relayed a 402 into a group of
          // seventeen, key link included.
          return json(
            { error: device.audience ? "the model could not answer that right now" : ev.message },
            502,
          );
        }
      }
      const ms = Math.round(performance.now() - started);
      if (thread && answer) {
        // Held so a later "that was wrong" can name the question and what it
        // retrieved. Only the owner can file one, but recording happens for
        // every thread: the owner is often reacting to an answer given to
        // somebody else in the room.
        recordAsk(db, { id: crypto.randomUUID(), thread, question, sources });
        remember(db, thread, "user", question, speaker);
        remember(db, thread, "assistant", answer);
        // After the reply, never before: summarising is a model call, and
        // making someone wait for one to get an answer to "haan" is the wrong
        // trade. A failure leaves the turns in place to try again next time.
        void summarise(db, thread, llm).catch((e) => console.error("summarise failed:", e));
      }
      // Tokens on the same line as the answer, because a system that spends
      // money with no instrument reporting it is how a 402 becomes a surprise.
      const spend = spendLabel(usage);
      console.log(`${orange("ask")} "${question.slice(0, 60)}" ${grey(`-> ${sources.length} sources ${ms}ms${spend}${memory.turns.length ? ` +${memory.turns.length} turns` : ""}${memory.summary ? " +summary" : ""} <${device.deviceName}>`)}`);
      if (usage?.stopReason === "length") {
        // The failure this exists to catch: an answer cut at max_tokens looks
        // exactly like a short answer to everyone downstream, including the
        // person reading it.
        console.error(
          `${orange("ask")} answer was truncated at ${config.ask?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS} output tokens. ` +
            `raise ask.maxTokens, or ask a narrower question`,
        );
        recordFailure(db, { kind: "ask-truncated", detail: `${usage.outputTokens ?? "?"} output tokens`, source: device.deviceName });
      }
      // Withheld, not just uncited: a path in the JSON is the same disclosure
      // as a path in the answer, and a chat client logs what it receives.
      return json({
        ok: true,
        question,
        answer,
        sources: profile.prompt.cite === false ? [] : sources,
        ms,
        ...(usage ? { usage } : {}),
        ...(usage?.stopReason === "length" ? { truncated: true } : {}),
      });
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
  };

  return { handle, whatsapp };
}
