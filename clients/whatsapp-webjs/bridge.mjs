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
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import qrcode from "qrcode-terminal";

// whatsapp-web.js is CommonJS and has no named ESM exports.
const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require("whatsapp-web.js");

// Both mirror tama-server's own limits so the rejection is a WhatsApp reply
// rather than a 413 the user never sees.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const REPLY_CHARS = 4000;

const TAMA_URL = (process.env.TAMA_URL ?? "http://tama:8080").replace(/\/+$/, "");
const SESSION_DIR = process.env.WA_SESSION_DIR ?? "/session";
const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium";
const SETTINGS_PATH = process.env.WA_SETTINGS ?? "/etc/tama/whatsapp-bridge.json";

/**
 * `tama-server setup` and `tama-server settings` write this file: the device
 * token they minted, the numbers allowed to write in, and what plain self-chat
 * text means. Environment variables still win, so a one-off override or a
 * deployment that predates the wizard support keeps working, but nobody should
 * have to hand-edit .env to add a phone number.
 */
function loadSettings() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
    console.log(stamp(), "settings", SETTINGS_PATH);
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("could not read", SETTINGS_PATH, "-", error?.message ?? error);
  }
  // Truthy, not defined: Compose passes WA_ALLOWED through as an empty string
  // whether or not anyone set it, and an empty override would silently wipe the
  // allowlist the wizard just wrote.
  const numbers = process.env.WA_ALLOWED
    ? process.env.WA_ALLOWED.split(",")
    : Array.isArray(file.allowedFrom) ? file.allowedFrom : [];
  // Env wins, which means an old .env can silently outvote what the wizard just
  // wrote. Say so rather than letting someone re-answer the same questions.
  for (const [name, fileValue] of [["TAMA_TOKEN", file.token], ["WA_ALLOWED", file.allowedFrom]]) {
    if (process.env[name] && fileValue !== undefined) {
      console.error(stamp(), `warning: ${name} in the environment overrides ${SETTINGS_PATH}; remove it from .env to use the settings file`);
    }
  }
  return {
    token: process.env.TAMA_TOKEN || file.token || "",
    // Digits only, country code included: "919876543210".
    allowed: new Set(numbers.map((n) => String(n).replace(/[^\d]/g, "")).filter(Boolean)),
    askPrefix: process.env.WA_ASK_PREFIX || file.askPrefix || "?",
    // Answering is the default: a bot that stays silent when you talk to it
    // reads as broken, whatever the reasoning behind the silence.
    selfChatText: process.env.WA_SELF_CHAT_TEXT || file.selfChatText || "ask",
  };
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(stamp(), ...parts);

const settings = loadSettings();
const TAMA_TOKEN = settings.token;
const ALLOWED = settings.allowed;
const ASK_PREFIX = settings.askPrefix;
const SELF_CHAT_TEXT = settings.selfChatText;

if (!TAMA_TOKEN) {
  console.error(
    `No device token. Expected one in ${SETTINGS_PATH} or in TAMA_TOKEN.\n` +
      "Run `tama-server setup` and choose \"Link your own WhatsApp number\" under WhatsApp,\n" +
      "or `tama-server settings` if the bridge is already set up. In Docker:\n" +
      "  docker compose run --rm setup",
  );
  process.exit(1);
}

/**
 * Retries only the failures that are worth retrying: a refused connection while
 * tama is still booting, and the 503 the MAX_INFLIGHT gate returns when two
 * captures are already transcribing.
 *
 * Not 502. That is tama reporting that the model provider refused - out of
 * credit, wrong key, no such model - and asking three times changes none of
 * those. It also used to end in a thrown error and no WhatsApp reply at all,
 * so a permanent failure looked exactly like the bridge being broken.
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
      if (res.status === 503 || (res.status >= 500 && res.status !== 502)) {
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

/**
 * Chromium writes a SingletonLock naming the host that holds the profile. A
 * container that died without closing the browser leaves it behind, and the
 * next container has a different hostname, so Chromium reads the lock as
 * "another computer is using this profile" and refuses to start. Nothing else
 * can be holding it: the profile lives in a volume only this service mounts.
 */
function clearStaleChromiumLocks(dir, depth = 3) {
  if (depth < 0 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.name.startsWith("Singleton")) {
      rmSync(full, { force: true, recursive: true });
      log("cleared stale Chromium lock", full);
    } else if (entry.isDirectory()) {
      clearStaleChromiumLocks(full, depth - 1);
    }
  }
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    // Explicit, because supplying a puppeteer object replaces whatsapp-web.js's
    // default wholesale - including the headless flag it would have set. There
    // is no display in a container, so omitting this fails with "Can't open
    // display" rather than falling back.
    headless: true,
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
let selfNumber = "";

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
    // Ask for the chat shape: no markdown, since WhatsApp shows the asterisks,
    // no note paths, since nobody here can open one, and a couple of sentences
    // rather than an essay in a bubble.
    body: JSON.stringify({ question, style: "chat" }),
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

/**
 * Every digit string that could identify the sender, because no single one of
 * them is reliable.
 *
 * WhatsApp now addresses many one-to-one chats as `<opaque id>@lid` instead of
 * `<number>@c.us`. Which fields then carry the actual phone number depends on
 * the WhatsApp Web build and on whether the contact is in your address book -
 * `getContact()` can answer with the lid id itself. Rather than pick a winner
 * and be wrong on somebody's install, collect the candidates and let a match on
 * any of them count.
 *
 * The allowlist is a list of things the user says they trust, so widening what
 * counts as "this sender" does not widen who gets in: an unlisted number still
 * matches nothing.
 */
async function senderIdentifiers(message, chatId) {
  const found = new Set();
  const add = (value) => {
    const digits = String(value ?? "").replace(/@.*$/, "").replace(/[^\d]/g, "");
    if (digits) found.add(digits);
  };

  add(chatId);
  // Raw fields, guarded: newer builds carry the phone-number jid alongside the
  // lid one, under names that have changed more than once.
  const raw = message._data ?? {};
  for (const key of ["senderPn", "participantPn", "author", "from", "peerRecipientPn"]) add(raw[key]);
  add(raw.id?.remote);

  try {
    const contact = await message.getContact();
    add(contact?.number);
    add(contact?.id?.user);
    // A lid contact usually has the real number one hop away.
    if (contact?.id?.server === "lid") {
      const alt = await client.getContactById(String(contact.id.user) + "@c.us").catch(() => undefined);
      add(alt?.number);
    }
  } catch { /* the ids above are enough to log something actionable */ }

  return found;
}

async function onMessage(message) {
  if (message.id?._serialized && ours.has(message.id._serialized)) return;

  const chatId = message.fromMe ? message.to : message.from;
  // Every inbound message says what was decided about it. Silently ignoring
  // most of them is correct behaviour and undebuggable behaviour at once:
  // without this line there is no way to tell "filtered" from "never arrived".
  const seen = (verdict) => log("seen", message.type ?? "?", chatId ?? "?", message.fromMe ? "fromMe" : "inbound", "->", verdict);

  if (!chatId) {
    seen("ignored, no chat id");
    return;
  }

  // Groups are never captured: a second brain filling up with other people's
  // chatter is a worse failure than missing a note. Ask the chat whether it is
  // a group rather than matching an id suffix, because the suffixes changed -
  // treating everything that was not `@c.us` as "not a direct chat" silently
  // dropped every message from a chat WhatsApp had moved to `@lid`.
  let isGroup = chatId.endsWith("@g.us");
  try {
    const chat = await message.getChat();
    if (chat) isGroup = chat.isGroup === true;
  } catch { /* keep the suffix guess */ }
  if (isGroup || chatId.endsWith("@broadcast") || chatId === "status@broadcast") {
    seen("ignored, not a one-to-one chat");
    return;
  }

  const ids = await senderIdentifiers(message, chatId);
  // Self-chat by number, not by chat id: under `@lid` addressing the id of your
  // own chat is not derivable from your own wid.
  const isSelfChat = (selfNumber && ids.has(selfNumber)) || chatId === selfId;

  // Your own outgoing half of someone else's chat is not input.
  if (message.fromMe && !isSelfChat) {
    seen("ignored, your own message to someone else");
    return;
  }

  if (!isSelfChat && ![...ids].some((id) => ALLOWED.has(id))) {
    // Print every candidate. If none of them is the number the user recognises,
    // this line is what tells them which value to allow instead.
    seen(`ignored, none of [${[...ids].join(", ")}] is on the allowed list`);
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
  if (isSelfChat && SELF_CHAT_TEXT === "ignore") {
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
  // Answering mode still honours the prefix, so a habit formed under the other
  // setting keeps working instead of asking about the literal "?" characters.
  if (isSelfChat && text.startsWith(ASK_PREFIX)) {
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
  selfNumber = (client.info?.wid?.user ?? "").replace(/[^\d]/g, "");
  log("ready as", selfId);
  log("tama", TAMA_URL);
  log("allowed senders", ALLOWED.size ? [...ALLOWED].join(", ") : "none (your own self-chat only)");
  log("self-chat text", SELF_CHAT_TEXT === "ask" ? "answered as a question" : `ignored unless prefixed with "${ASK_PREFIX}"`);
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
  onMessage(message).catch(async (error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("handler failed:", detail);
    // Whatever went wrong, the person who sent the message is still waiting.
    // Failing quietly is what made a plain out-of-credit error look like a
    // dead bridge for an hour.
    try {
      await reply(message, `Something went wrong handling that: ${detail}`);
    } catch (replyError) {
      console.error("could not report the failure either:", replyError instanceof Error ? replyError.message : replyError);
    }
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("shutting down");
    client.destroy().finally(() => process.exit(0));
  });
}

log("starting; first run prints a QR code");
clearStaleChromiumLocks(SESSION_DIR);
client.initialize();
