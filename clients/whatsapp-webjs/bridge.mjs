/**
 * A WhatsApp client for Tama, built on whatsapp-web.js.
 *
 * This is a *client*, exactly like the iOS Shortcut. It holds a device token
 * and posts to the same public /capture and /ask routes; tama-server has no
 * idea it exists and needs no configuration for it. Nothing here touches the
 * vault, the database or the `whatsapp` config block.
 *
 * Unofficial by construction: it logs into WhatsApp Web as your own account
 * instead of going through Meta's Cloud API. That is what makes it cheap —
 * no business app, no dedicated number, and no public HTTPS callback, because
 * the connection is outbound — and equally what makes it a terms-of-service
 * violation that can get the account banned. The supported path is the
 * `whatsapp` block in tama.config.json.
 *
 * Routing mirrors the Cloud API adapter: a voice note is a capture, text is a
 * question. The one difference is your own chat with yourself, where plain
 * text is left alone and only the ask prefix asks — see onMessage.
 */

import { createRequire } from "node:module";
import qrcode from "qrcode-terminal";

// whatsapp-web.js is CommonJS and has no named ESM exports.
const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require("whatsapp-web.js");

// Both mirror tama-server's own limits so the rejection is a WhatsApp reply
// rather than a 413 the user never sees.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const REPLY_CHARS = 4000;

const TAMA_URL = (process.env.TAMA_URL ?? "http://tama:8080").replace(/\/+$/, "");
const TAMA_TOKEN = process.env.TAMA_TOKEN ?? "";
const ASK_PREFIX = process.env.WA_ASK_PREFIX ?? "?";
const SESSION_DIR = process.env.WA_SESSION_DIR ?? "/session";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";

// Digits only, country code included: "919876543210". An empty list means
// only your own self-chat is honoured, which is the safe default.
const ALLOWED = new Set(
  (process.env.WA_ALLOWED ?? "")
    .split(",")
    .map((n) => n.replace(/[^\d]/g, ""))
    .filter(Boolean),
);

if (!TAMA_TOKEN) {
  console.error(
    "TAMA_TOKEN is not set. Mint a device token first:\n" +
      "  CODE=$(curl -s -X POST localhost:8080/pair/code -H \"Authorization: Bearer $ADMIN\" | jq -r .code)\n" +
      "  curl -s -X POST localhost:8080/pair -H 'content-type: application/json' \\\n" +
      "    -d \"{\\\"code\\\":\\\"$CODE\\\",\\\"deviceName\\\":\\\"whatsapp-bridge\\\"}\" | jq -r .token\n" +
      "then put it in .env as TAMA_TOKEN=…",
  );
  process.exit(1);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(stamp(), ...parts);

/**
 * Retries only the failures that are worth retrying: a refused connection
 * while tama is still booting, and the 503 the MAX_INFLIGHT gate returns when
 * two captures are already transcribing. A 4xx is the user's problem and is
 * reported as-is.
 */
async function post(path, { headers = {}, body }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${TAMA_URL}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${TAMA_TOKEN}`, ...headers },
        body,
        signal: AbortSignal.timeout(300_000),
      });
      if (res.status === 503 || res.status >= 500) {
        lastError = new Error(`HTTP ${res.status}`);
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("request failed");
}

/** WhatsApp rejects messages past ~4096 characters, so answers arrive split. */
function splitReply(text) {
  const clean = text.trim() || "Tama did not produce a reply.";
  const chunks = [];
  let rest = clean;
  while (rest.length > REPLY_CHARS) {
    const window = rest.slice(0, REPLY_CHARS);
    const boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
    const at = boundary > REPLY_CHARS / 2 ? boundary : REPLY_CHARS;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    executablePath: CHROMIUM_PATH,
    // --no-sandbox is required to run Chromium as root in a container; the
    // shm flag stops it dying on Docker's 64MB default /dev/shm.
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  },
  // WhatsApp Web ships breaking changes on its own schedule. Pinning the page
  // is the documented escape hatch when a new release stops loading.
  ...(process.env.WA_WEB_VERSION_HTML
    ? { webVersionCache: { type: "remote", remotePath: process.env.WA_WEB_VERSION_HTML } }
    : {}),
});

/**
 * Message ids this process sent. In your own self-chat a reply is itself a
 * fromMe message, so without this the answer to a question would be read back
 * as the next question.
 */
const ours = new Set();

let selfId = "";

async function reply(message, text) {
  for (const chunk of splitReply(text)) {
    const sent = await message.reply(chunk);
    if (sent?.id?._serialized) ours.add(sent.id._serialized);
  }
}

async function capture(message) {
  const media = await message.downloadMedia();
  if (!media?.data) {
    await reply(message, "That voice note did not download, so nothing was saved.");
    return;
  }
  const audio = Buffer.from(media.data, "base64");
  if (audio.byteLength > MAX_UPLOAD_BYTES) {
    await reply(message, "That voice note is too large for Tama (25 MB maximum), so nothing was saved.");
    return;
  }

  const res = await post("/capture", {
    headers: {
      "content-type": media.mimetype || "audio/ogg",
      // WhatsApp redelivers on reconnect. The message id is stable, so the
      // server's idempotency table collapses a redelivery into one note.
      "idempotency-key": message.id._serialized,
      "x-tama-captured-at": new Date(message.timestamp * 1000).toISOString(),
    },
    body: audio,
  });
  const body = await res.json().catch(() => ({}));

  if (res.ok) {
    log("capture", body.path, `${audio.byteLength}B`, `${body.audioSeconds ?? "?"}s`);
    await reply(message, `Saved to your second brain.\n${body.path ?? "Capture complete"}`);
    return;
  }
  if (res.status === 422) {
    await reply(message, "I couldn't hear any speech in that voice note, so nothing was saved.");
    return;
  }
  if (res.status === 413) {
    await reply(message, "That voice note is too large for Tama (25 MB maximum), so nothing was saved.");
    return;
  }
  log("capture failed", res.status, body.error ?? "");
  await reply(message, `I couldn't save that voice note: ${body.error ?? `HTTP ${res.status}`}`);
}

async function askQuestion(message, question) {
  const res = await post("/ask", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 501) {
    await reply(message, "Ask is not configured on this Tama server yet. Voice notes still work.");
    return;
  }
  if (!res.ok) {
    log("ask failed", res.status, body.error ?? "");
    await reply(message, `I couldn't answer that: ${body.error ?? `HTTP ${res.status}`}`);
    return;
  }
  log("ask", `"${question.slice(0, 60)}"`, `-> ${body.sources?.length ?? 0} sources ${body.ms ?? "?"}ms`);
  await reply(message, body.answer ?? "");
}

async function onMessage(message) {
  if (message.id?._serialized && ours.has(message.id._serialized)) return;

  const chatId = message.fromMe ? message.to : message.from;
  // Every inbound message says what was decided about it. Silently ignoring
  // most of them is correct behaviour and undebuggable behaviour at once:
  // without this line there is no way to tell "filtered" from "never arrived".
  const seen = (verdict) => log("seen", message.type ?? "?", chatId ?? "?", message.fromMe ? "fromMe" : "inbound", "->", verdict);

  // Groups are never captured. A second brain filling up with other people's
  // chatter is a worse failure than missing a note.
  if (!chatId || !chatId.endsWith("@c.us")) {
    seen("ignored, not a direct chat");
    return;
  }

  const isSelfChat = chatId === selfId;
  // Your own outgoing half of someone else's chat is not input.
  if (message.fromMe && !isSelfChat) {
    seen("ignored, your own message to someone else");
    return;
  }

  const number = chatId.replace(/@c\.us$/, "");
  if (!isSelfChat && !ALLOWED.has(number)) {
    seen(`ignored, ${number} is not in WA_ALLOWED`);
    return;
  }

  const isVoice = message.hasMedia && (message.type === "ptt" || message.type === "audio");
  const text = (message.body ?? "").trim();

  if (isVoice) {
    seen("capture");
    return capture(message);
  }
  if (!text) {
    seen("ignored, no text and no audio");
    return;
  }

  // Self-chat is also a scratchpad, so plain text there is left alone and
  // only the prefix asks. In a chat with someone else there is nothing to
  // mistake, and text behaves as it does on the Cloud API path.
  if (isSelfChat) {
    if (!text.startsWith(ASK_PREFIX)) {
      seen(`ignored, self-chat text without the "${ASK_PREFIX}" prefix`);
      return;
    }
    const question = text.slice(ASK_PREFIX.length).trim();
    if (!question) {
      seen("ignored, prefix with no question after it");
      return;
    }
    seen("ask");
    return askQuestion(message, question);
  }
  seen("ask");
  return askQuestion(message, text);
}

client.on("qr", (qr) => {
  console.log("\nScan this with WhatsApp -> Settings -> Linked devices -> Link a device\n");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => log("authenticated; session saved to", SESSION_DIR));

client.on("ready", () => {
  selfId = client.info?.wid?._serialized ?? "";
  log("ready as", selfId);
  log("tama", TAMA_URL);
  log("allowed senders", ALLOWED.size ? [...ALLOWED].join(", ") : `none (self-chat only, ask prefix "${ASK_PREFIX}")`);
});

client.on("auth_failure", (m) => {
  console.error("auth failed:", m, "- delete the session volume and scan again");
  process.exit(1);
});

// Exiting hands the problem to the restart policy, which is the only thing
// that can actually re-establish the socket or surface a fresh QR.
client.on("disconnected", (reason) => {
  console.error("disconnected:", reason);
  process.exit(1);
});

// message_create covers incoming and outgoing both, so self-chat works; the
// plain "message" event would miss it.
client.on("message_create", (message) => {
  onMessage(message).catch((error) => {
    console.error("handler failed:", error instanceof Error ? error.message : error);
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("shutting down");
    client.destroy().finally(() => process.exit(0));
  });
}

log("starting; first run prints a QR code");
client.initialize();
