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
 * Routing mirrors the Cloud API adapter: a voice note is a capture and text is
 * a question, including plain text in your own chat with yourself.
 */

import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import qrcode from "qrcode-terminal";
import { downloadRawMedia } from "./media-download.mjs";
import { errorDetail } from "./http-error.mjs";
import { verdictFromCommand, verdictFromReaction } from "./feedback-input.mjs";
import { repairSerializedMessageId } from "./message-id.mjs";
import { stripOurMention } from "./mention.mjs";

// whatsapp-web.js is CommonJS and has no named ESM exports.
const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require("whatsapp-web.js");

/**
 * What this client tells the server it is, on every request.
 *
 * tama advertises a `minClient` on /health and now refuses a capture from a
 * client that says it is older than that. Silence is accepted - the header
 * postdates every deployed client - so sending it is what makes this bridge
 * eligible to be refused, which is the point: a version the server can read is
 * how a breaking change stops being a mystery on somebody's phone.
 *
 * Read from package.json rather than written twice. Two copies of a version
 * number in one client is the pair that drifts.
 */
const CLIENT = `tama-whatsapp-webjs/${require("./package.json").version}`;

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
 * token they minted and the numbers allowed to write in. Environment variables
 * still win, so a one-off override or a deployment that predates the wizard
 * support keeps working, but nobody should have to hand-edit .env to add a
 * phone number.
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
  // An audience is a match rule plus the token minted for it. The bridge holds
  // one token per audience and never decides what any of them may see: the
  // server derives the view, voice and flags from the token. So a wrong rule
  // here sends a question to the wrong audience, which is bad, but it cannot
  // widen what that audience can read.
  const audiences = Array.isArray(file.audiences) ? file.audiences : [];
  return {
    audiences: audiences
      .filter((a) => a && a.token)
      .map((a) => ({
        name: String(a.name ?? "unnamed"),
        token: String(a.token),
        mention: ["when-mentioned", "in-conversation", "always"].includes(a.mention) ? a.mention : "in-conversation",
        match: (Array.isArray(a.match) ? a.match : []).map((m) => String(m)),
      })),
    token: process.env.TAMA_TOKEN || file.token || "",
    // The owner's other numbers, digits only with the country code. Treated as
    // the owner rather than as guests: another phone is the same person.
    allowed: new Set(numbers.map((n) => String(n).replace(/[^\d]/g, "")).filter(Boolean)),
  };
}

/**
 * How long an exchange stays open, and how much it may say inside one.
 *
 * "in-conversation" answers while a conversation is live, which needs a
 * definition of live: a few minutes since it last spoke in that chat.
 *
 * The cap is a runaway guard, not a politeness setting, and the first numbers
 * confused the two. Eight replies in ten minutes is a normal afternoon in a
 * group of seventeen that finds the bot funny, so it went quiet mid-conversation
 * and looked broken. Thirty still stops a loop with another bot, which is the
 * thing actually worth stopping, since that is somebody's bill.
 */
const CONVERSATION_MS = Number(process.env.WA_CONVERSATION_MINUTES ?? 5) * 60_000;
const REPLY_BUDGET = Number(process.env.WA_REPLY_BUDGET ?? 30);
const BUDGET_MS = Number(process.env.WA_BUDGET_MINUTES ?? 10) * 60_000;

/** When it last spoke in a chat, and when each of those replies happened. */
const lastSpoke = new Map();
const spokeAt = new Map();

function recordReply(chatId) {
  const now = Date.now();
  lastSpoke.set(chatId, now);
  spokeAt.set(chatId, [...(spokeAt.get(chatId) ?? []).filter((t) => now - t < BUDGET_MS), now]);
}

function withinBudget(chatId) {
  const now = Date.now();
  const recent = (spokeAt.get(chatId) ?? []).filter((t) => now - t < BUDGET_MS);
  spokeAt.set(chatId, recent);
  return recent.length < REPLY_BUDGET;
}

function inConversation(chatId) {
  const last = lastSpoke.get(chatId);
  return Boolean(last && Date.now() - last < CONVERSATION_MS);
}

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(stamp(), ...parts);

let settings = loadSettings();

/**
 * Reload when the settings file changes, instead of asking for a restart.
 *
 * Everything read from that file is data - a token, some numbers, which chats
 * belong to which audience - so there is nothing to rebuild. Requiring a
 * restart to add a phone number was the deployment showing through again, and
 * it also means a browser session torn down and re-established for a one-line
 * config change.
 *
 * Watched rather than polled, debounced because an atomic write is a create
 * plus a rename and arrives as several events.
 */
function watchSettings() {
  let pending;
  try {
    watch(SETTINGS_PATH, () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        const before = JSON.stringify(settings);
        const next = loadSettings();
        if (JSON.stringify(next) === before) return;
        settings = next;
        log("settings reloaded", `${settings.audiences.length} audience(s), ${settings.allowed.size} of your numbers`);
        for (const a of settings.audiences) log("audience", a.name, `matches ${a.match.join(", ") || "nothing"}`, a.mention);
      }, 250);
    });
  } catch (error) {
    // A watch can fail on some filesystems. Losing it costs a restart, which
    // is where this started, so it is not fatal.
    console.error("could not watch the settings file, so changes need a restart:", error?.message ?? error);
  }
}

if (!settings.token) {
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
async function post(path, { headers = {}, body, token }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${TAMA_URL}${path}`, {
        method: "POST",
        // Read per attempt, so a token re-issued in settings takes effect on
        // the next message rather than the next restart.
        headers: { authorization: `Bearer ${token ?? settings.token}`, "x-tama-client": CLIENT, ...headers },
        body,
        signal: AbortSignal.timeout(300_000),
      });
      if (res.status === 503 || (res.status >= 500 && res.status !== 502)) {
        // Keep what the server said. It answers a failed capture with
        // {"error": "<what actually broke>"}, and discarding that is how
        // "ffmpeg is not installed" reached a phone as a bare "HTTP 500" -
        // a failure in the one path that is supposed to need nothing, naming
        // nothing, to the person most likely able to fix it.
        lastError = new Error(`HTTP ${res.status}${await errorDetail(res)}`);
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
 * What this process said, so it does not answer itself.
 *
 * Two mechanisms, because one is not enough. `ours` holds the ids of messages
 * we sent, which is exact but only known after the send resolves - and the
 * message_create event for our own reply can arrive before that, which is how
 * a reply ended up being read back as a new message. `saying` holds the text
 * we are about to send, keyed by chat, and is populated before the send starts.
 *
 * In a group with onNoMatch "just talk" this is not cosmetic: without it the
 * bot answers its own answer, forever.
 */
const ours = new Set();
const saying = new Set();
const utterance = (chatId, text) => `${chatId}\u0000${text.trim()}`;

let selfId = "";
let selfNumber = "";

/**
 * Every digit string that means us.
 *
 * `selfNumber` is the phone number and `selfId` the jid it came from, which
 * under `@lid` addressing is an opaque id instead - and a mention of us can
 * carry either one.
 */
function ourNumbers() {
  return [selfNumber, String(selfId).replace(/@.*$/, "").replace(/\D/g, "")].filter(Boolean);
}

async function reply(message, text) {
  const chatId = message.fromMe ? message.to : message.from;
  recordReply(chatId);
  for (const chunk of splitReply(text)) {
    const key = utterance(chatId, chunk);
    saying.add(key);
    try {
      const sent = await message.reply(chunk);
      if (sent?.id?._serialized) ours.add(sent.id._serialized);
    } finally {
      // Long enough to cover the echo, short enough that saying the same thing
      // twice on purpose still works.
      setTimeout(() => saying.delete(key), 60_000).unref?.();
    }
  }
}

/**
 * Fetch the audio, with retries.
 *
 * `downloadMedia()` throws minified internal errors from WhatsApp Web - a
 * voice note failed here with the message "r" - and it is usually transient:
 * the media is fetched from WhatsApp's servers when asked for, and asking again
 * a second later tends to work. Failing on the first attempt loses a note the
 * user has already spoken, which is the one outcome this whole product exists
 * to prevent.
 */
async function downloadAudio(message) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    try {
      const media = await message.downloadMedia();
      if (media?.data) return media;
      lastError = new Error("no data returned");
    } catch (error) {
      lastError = error;
    }
    // A WhatsApp Web LID migration can leave the message visible to the event
    // handler but absent from the collection downloadMedia() searches. The
    // Message still carries the encrypted-media fields, so use the library's
    // own browser download manager without repeating the broken lookup.
    try {
      const media = await downloadRawMedia(message, client.pupPage);
      if (media?.data) {
        log("media download", "used raw-message fallback");
        return media;
      }
    } catch (error) {
      lastError = error;
    }
    log("media download failed", `attempt ${attempt + 1}: ${lastError?.message ?? lastError}`);
  }
  throw lastError ?? new Error("could not download the audio");
}

async function capture(message) {
  const messageId = repairSerializedMessageId(message);
  if (!messageId) {
    log("capture failed", "WhatsApp supplied no stable message id");
    await reply(message, "I couldn't identify that voice note safely. Send it again?");
    return;
  }

  let media;
  try {
    media = await downloadAudio(message);
  } catch (error) {
    log("capture failed", `download: ${error?.message ?? error}`);
    // Named for what the user can do about it. "r" told them nothing.
    await reply(message, "couldn't download that voice note from whatsapp. send it again?");
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
      "idempotency-key": messageId,
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

async function askQuestion(message, question, audience, who, thread) {
  const res = await post("/ask", {
    token: audience?.token,
    headers: { "content-type": "application/json" },
    // No style with an audience: its shape comes from its token. The owner's
    // own token has no audience, so it asks for the chat shape itself.
    //
    // Who is speaking only matters in a room with more than one person, and it
    // is asserted here because only this client can know it.
    body: JSON.stringify({
      question,
      ...(audience ? {} : { style: "chat" }),
      // Which app this is and what number it answers on. Only this client can
      // know either, and until it said so the model was guessing about the
      // medium it was speaking through and had nothing at all for its own
      // address. The server renders the sentence: this names the surface, not
      // what to say about it.
      surface: { app: "whatsapp", ...(selfNumber ? { address: selfNumber } : {}) },
      ...(who?.name ? { speaker: who.name } : {}),
      ...(who ? { speakerIsOwner: who.isOwner } : {}),
      // One chat, one thread. The server scopes it by token as well, so two
      // audiences reachable in the same chat cannot read each other's history.
      ...(thread ? { thread } : {}),
    }),
  });
  const body = await res.json().catch(() => ({}));

  if (res.status === 501) {
    await reply(message, "Ask is not configured on this Tama server yet. Voice notes still work.");
    return;
  }
  if (!res.ok) {
    log("ask failed", res.status, body.error ?? "");
    // Never relay the detail into a room the owner does not control. The
    // server already withholds it from an audience; this is the second half of
    // the same rule, for the case where the failure happened here.
    await reply(message, audience
      ? "abhi dimaag kaam nahi kar raha, thodi der baad bol"
      : `I couldn't answer that: ${body.error ?? `HTTP ${res.status}`}`);
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

/**
 * Persist a change to this client's own settings file.
 *
 * Read, mutate, write: the file is also written by `tama settings`, and
 * rewriting it from the in-memory view would drop anything added there since
 * this process started.
 */
function patchSettings(mutate) {
  const file = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  mutate(file);
  writeFileSync(SETTINGS_PATH, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  return file;
}

/**
 * Attach an audience to the chat it was sent from.
 *
 * The alternative was: find a group id WhatsApp shows nowhere, or send a
 * message and then go to a terminal to pick the group from a menu. Both make
 * someone leave the room they are already standing in. `/tama 315` in the group
 * is the whole step.
 *
 * Only the owner may do this. In a group everyone can type, so the command is
 * accepted from the linked phone and the owner's other numbers and from nobody
 * else, which is the same boundary the rest of the bridge uses.
 */
/**
 * Report a verdict on the last answer in this chat.
 *
 * Always the owner's token, never an audience's: /feedback is owner-only,
 * because in a group the question is often somebody else's message and the
 * record is permanent. The bridge holds an audience token per room, and using
 * one here would simply be refused.
 *
 * The chat id is the thread, which is the same value askQuestion sends, so the
 * server can attach the verdict to what it actually retrieved. The bridge never
 * sees those paths and does not need to: an audience with cite:false is not
 * told them at all.
 */
async function sendFeedback(message, chatId, verdict) {
  const res = await post("/feedback", {
    headers: { "content-type": "application/json" },
    token: settings.token,
    body: JSON.stringify({ thread: chatId, ...verdict }),
  });
  if (res.status === 404) {
    // The thread is fine, there is just nothing recent enough to be about.
    await reply(message, "Nothing recent enough to rate in this chat");
    return;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    log("feedback failed", res.status, body.error ?? "");
    await reply(message, `Could not record that: ${body.error ?? `HTTP ${res.status}`}`);
    return;
  }
  const body = await res.json().catch(() => ({}));
  // Quoted back so the owner can see which question it landed on. A silent
  // acknowledgement would make a verdict on the wrong answer invisible.
  await reply(message, `Noted as ${verdict.verdict}: "${String(body.question ?? "").slice(0, 80)}"`);
}

/**
 * The name to attribute a group message to.
 *
 * WhatsApp's push name is what the sender chose to be called, which is also
 * what everyone in the group sees, so it is the right handle for a reply that
 * names them. Falls back to the number, since a reply that says "someone" is
 * worse than one that says a number.
 *
 * The owner used to be reported as "you", which the server rendered as "A
 * message from you (the owner...)". A model reads "you" as itself, so being
 * mentioned in a group came back as "you are saying hello to yourself". Who the
 * owner is travels in `speakerIsOwner`; this is only ever a name.
 */
async function speakerName(message) {
  try {
    const contact = await message.getContact();
    const name = contact?.pushname || contact?.name || contact?.number;
    if (name) return String(name);
  } catch { /* fall through */ }
  return message._data?.notifyName ? String(message._data.notifyName) : undefined;
}

/**
 * Whether a group message is addressed to us.
 *
 * Every one of these has failed on some build, so all of them are checked.
 * `mentionedIds` is the documented accessor and `_data.mentionedJidList` the
 * raw field behind it, but which one is populated varies, and under `@lid`
 * addressing a mention can carry an opaque id rather than the phone number -
 * so the number appearing in the body is worth checking too.
 *
 * Replying to something we said counts. In a group that is how people address a
 * bot, and treating it as silence is the same as ignoring them.
 */
async function mentionsUs(message, text) {
  const candidates = [];
  try {
    const ids = await message.getMentions?.();
    for (const c of ids ?? []) candidates.push(c?.id?._serialized, c?.number, c?.id?.user);
  } catch { /* the raw fields below are the fallback */ }
  for (const j of message.mentionedIds ?? []) candidates.push(String(j?._serialized ?? j));
  for (const j of message._data?.mentionedJidList ?? []) candidates.push(String(j?._serialized ?? j));

  const digits = candidates.filter(Boolean).map((c) => String(c).replace(/[^\d]/g, ""));
  if (selfNumber && digits.includes(selfNumber)) return true;
  if (selfNumber && text.includes(selfNumber)) return true;

  // A reply to one of ours is being spoken to.
  if (message.hasQuotedMsg) {
    try {
      const quoted = await message.getQuotedMessage();
      if (quoted?.fromMe || (quoted?.id?._serialized && ours.has(quoted.id._serialized))) return true;
    } catch { /* not decisive either way */ }
  }

  // Logged, because "it ignored me" needs to be diagnosable without a debugger.
  log("not addressed to us", `mentions=[${digits.join(", ")}] me=${selfNumber}`);
  return false;
}

async function claimChat(message, chatId, name) {
  const target = name.trim();
  const waiting = (settings.audiences ?? []).filter((a) => a.match.length === 0).map((a) => a.name);

  if (!target) {
    await reply(message, waiting.length
      ? `send "/tama ${waiting[0]}" here to set this chat up as ${waiting.length === 1 ? "it" : "one of: " + waiting.join(", ")}`
      : "nothing is waiting for a chat. make an audience with tama settings first.");
    return;
  }

  const audience = (settings.audiences ?? []).find((a) => a.name === target);
  if (!audience) {
    await reply(message, `no audience called "${target}". ${waiting.length ? `waiting: ${waiting.join(", ")}` : "make one with tama settings first."}`);
    return;
  }

  patchSettings((file) => {
    file.audiences = (file.audiences ?? []).map((a) =>
      a.name === target ? { ...a, match: [...new Set([...(a.match ?? []), chatId])] } : a,
    );
  });
  // In memory too, so it takes effect now rather than at the next restart.
  audience.match = [...new Set([...audience.match, chatId])];
  log("claimed", chatId, "as", target);
  await reply(message, `done. this chat is "${target}" now.`);
}

async function onMessage(message) {
  // Current WhatsApp Web calls this field `$1`; whatsapp-web.js still expects
  // `_serialized` in downloadMedia(), reply(), and its other message methods.
  // Repair it once at the boundary so every later operation gets a real id.
  const messageId = repairSerializedMessageId(message);
  if (messageId && ours.has(messageId)) return;

  const chatId = message.fromMe ? message.to : message.from;
  if (chatId && saying.has(utterance(chatId, message.body ?? ""))) return;
  // Every inbound message says what was decided about it. Silently ignoring
  // most of them is correct behaviour and undebuggable behaviour at once:
  // without this line there is no way to tell "filtered" from "never arrived".
  const seen = (verdict) => log("seen", message.type ?? "?", chatId ?? "?", message.fromMe ? "fromMe" : "inbound", "->", verdict);

  if (!chatId) {
    seen("ignored, no chat id");
    return;
  }
  if (chatId.endsWith("@broadcast") || chatId === "status@broadcast") {
    seen("ignored, a broadcast");
    return;
  }

  // Ask the chat whether it is a group rather than matching an id suffix,
  // because the suffixes changed: treating everything that was not `@c.us` as
  // "not a direct chat" silently dropped every message from a chat WhatsApp had
  // moved to `@lid`.
  let isGroup = chatId.endsWith("@g.us");
  let groupName;
  try {
    const chat = await message.getChat();
    if (chat) {
      isGroup = chat.isGroup === true;
      groupName = chat.name;
    }
  } catch { /* keep the suffix guess */ }

  const ids = await senderIdentifiers(message, chatId);
  // Resolved before the group check, not after. The other way round meant a
  // group was rejected for being a group before anything could claim it, which
  // made every audience matching a group dead code.
  const audience = settings.audiences.find((a) =>
    a.match.some((m) => m === chatId || ids.has(String(m).replace(/[^\d]/g, ""))),
  );

  // "Is this the owner", independent of which chat it arrived in. In a group
  // this is how a command is told apart from the other sixteen people talking.
  const isOwner = Boolean((selfNumber && ids.has(selfNumber)) || [...ids].some((id) => settings.allowed.has(id)) || (message.fromMe && isGroup));

  if (isGroup) {
    // Recorded whether or not it is claimed. Only unclaimed groups used to be
    // remembered, so the one group actually in use was the one whose name
    // settings could not show.
    rememberChat(chatId, groupName);
    if (!audience && !isOwner) {
      // Still worth knowing about: one message in a group is now enough for
      // `tama settings` to offer it by name, so nobody has to find an id.
      if (!published.has(chatId)) {
        published.add(chatId);
        void publishChats();
        seen("ignored, no audience claims this group - published so settings can offer it");
        return;
      }
      seen("ignored, no audience claims this group");
      return;
    }
    if (!audience && !/^\/tama\b/i.test((message.body ?? "").trim())) {
      // The owner talking in a group that is not set up yet. Stay quiet: they
      // were talking to their friends, not to it.
      seen("ignored, this group has no audience. send /tama to set one up");
      return;
    }
  }

  // The allowlist is the owner's other numbers, not a guest list. A second
  // phone is still Shivansh, so it gets the self treatment: the owner's own
  // token and the whole vault. Anybody who is not the owner needs an audience,
  // which is what decides what they may see.
  const isSelfChat = (selfNumber && ids.has(selfNumber))
    || chatId === selfId
    || [...ids].some((id) => settings.allowed.has(id));

  // Your own outgoing half of someone else's one-to-one chat is not input. In a
  // group you are a participant, so your own messages count.
  if (message.fromMe && !isSelfChat && !isGroup) {
    seen("ignored, your own message to someone else");
    return;
  }

  if (!isSelfChat && !audience) {
    // Print every candidate. If none of them is the number the user recognises,
    // this line is what tells them which value to add.
    seen(`ignored, none of [${[...ids].join(", ")}] is one of your numbers or an audience`);
    return;
  }

  const isVoice = message.hasMedia && (message.type === "ptt" || message.type === "audio");
  const text = (message.body ?? "").trim();

  // Before the claim, because "/tama wrong" is a verdict and not the name of
  // an audience to claim this chat as.
  const verdict = verdictFromCommand(text);
  if (verdict && isOwner) {
    seen(`feedback ${verdict.verdict}`);
    return sendFeedback(message, chatId, verdict);
  }

  // Checked before the audience gate, so a group with no audience yet can still
  // be claimed - which is the only moment the command is useful.
  const claim = /^\/tama\b\s*(.*)$/i.exec(text);
  if (claim && isOwner) {
    seen("claim");
    return claimChat(message, chatId, claim[1] ?? "");
  }

  if (isVoice) {
    // An audience never captures. A second brain filling with other people's
    // voice notes is the failure the group ignore was always about, and an
    // audience's token is scoped for reading rather than writing.
    if (audience) {
      seen(`ignored, ${audience.name} does not capture`);
      return;
    }
    seen("capture");
    return capture(message);
  }
  if (!text) {
    // A captionless photo ended here in silence, which from the phone is
    // indistinguishable from the bridge being down - the failure that started
    // all of this. Say so instead.
    //
    // Only in the owner's own chat. A captionless image carries no text to
    // mention us in, so in a group there is no way to tell one meant for Tama
    // from the other sixteen people sharing pictures, and answering all of
    // them is the noise the mention gate exists to prevent.
    //
    // Stickers are deliberately not in the list. A sticker is a reaction, not
    // something somebody is waiting on an answer about.
    if (!audience && message.hasMedia && ["image", "video", "document"].includes(message.type)) {
      seen(`cannot see ${message.type}`);
      return reply(message, "I can't see images or files. Write it or send a voice note instead.");
    }
    seen("ignored, no text and no audio");
    return;
  }

  if (audience) {
    // "when mentioned" is what keeps a busy group from muting the bot. An @
    // mention resolves to the linked number, so match on that.
    // The owner never has to tag their own bot. Gating on a mention exists so
    // a group of sixteen people does not get a reply to every message; it was
    // never meant to make the person who set it up queue up like a stranger.
    if (audience.mention !== "always" && !isOwner) {
      const addressed = await mentionsUs(message, text);
      const following = audience.mention === "in-conversation" && inConversation(chatId);
      if (!addressed && !following) {
        seen(`ignored, ${audience.name} was not spoken to`);
        return;
      }
    }

    // The cap applies whatever the mode, including "always". Nothing else here
    // stops a loop with another bot, or a bad day in a very busy group.
    if (isGroup && !withinBudget(chatId)) {
      // Said out loud, because a silent bot mid-conversation reads as a bug.
      seen(`ignored, ${audience.name} hit its cap of ${REPLY_BUDGET} replies per ${BUDGET_MS / 60_000} min. raise it with WA_REPLY_BUDGET`);
      return;
    }
    seen(isOwner ? `ask as ${audience.name}, from you` : `ask as ${audience.name}`);
    // Stripped here and not where `text` is derived: the number appearing in
    // the body is one of the things mentionsUs() matches on, so taking it out
    // any earlier would stop us noticing we were spoken to at all.
    const question = stripOurMention(text, ourNumbers());
    return askQuestion(message, question, audience, { name: await speakerName(message), isOwner }, chatId);
  }



  // A leading "?" is stripped rather than required. It was a setting once, and
  // the habit outlives it; asking about the literal question mark would be a
  // worse answer than ignoring it.
  const question = text.startsWith("?") ? text.slice(1).trim() : text;
  if (!question) {
    seen("ignored, nothing but a question mark");
    return;
  }
  seen("ask");
  return askQuestion(message, question, undefined, undefined, chatId);
}

/**
 * A thumbs-down on one of our replies, which is the cheapest feedback there is.
 *
 * Guarded rather than assumed: whether a given WhatsApp Web build emits
 * `message_reaction` is not something this project can promise, so `/tama
 * wrong` exists beside it on the event the bridge already depends on. If this
 * never fires, nothing is lost except one tap's worth of convenience.
 *
 * Only reactions to OUR messages count. A thumbs-down on somebody else's
 * message in a group is an opinion about them, not about an answer.
 */
client.on("message_reaction", (reaction) => {
  void (async () => {
    try {
      const verdict = verdictFromReaction(reaction?.reaction);
      if (!verdict) return;
      if (!reaction?.msgId?.fromMe) return;

      const chatId = String(reaction.msgId.remote ?? "");
      if (!chatId) return;

      // Reacting to our own outbound message means the reactor is the owner on
      // the linked phone. A group member cannot react "from" our account.
      const res = await post("/feedback", {
        headers: { "content-type": "application/json" },
        token: settings.token,
        body: JSON.stringify({ thread: chatId, verdict }),
      });
      if (!res.ok) {
        log("reaction feedback failed", res.status);
        return;
      }
      const body = await res.json().catch(() => ({}));
      log("feedback", verdict, `"${String(body.question ?? "").slice(0, 60)}"`);
    } catch (error) {
      // A reaction is a bonus signal. Failing to record one must never take
      // the bridge down or interrupt a conversation.
      console.error("reaction handler failed:", error instanceof Error ? error.message : error);
    }
  })();
});

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
  log("your numbers", settings.allowed.size ? [...settings.allowed, selfNumber].join(", ") : `${selfNumber} (this phone only)`);
  for (const a of settings.audiences) log("audience", a.name, `matches ${a.match.join(", ") || "nothing"}`, a.mention);
  log("group limits", `a conversation stays open ${CONVERSATION_MS / 60_000} min, at most ${REPLY_BUDGET} replies per ${BUDGET_MS / 60_000} min`);
  // Settings runs in a container with no WhatsApp session, so it cannot ask
  // someone to type a group id. Publish what this session can see instead.
  void publishChats();
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
    // Who this chat belongs to, recomputed cheaply: a failure reply must not
    // put internals into a room the owner does not control, and by this point
    // the decision made inside onMessage is out of reach.
    const chatId = message.fromMe ? message.to : message.from;
    const inAudience = settings.audiences.some((a) => a.match.some((m) => m === chatId));
    // Whatever went wrong, the person who sent the message is still waiting.
    // Failing quietly is what made a plain out-of-credit error look like a
    // dead bridge for an hour.
    try {
      // Same reasoning: a stack of internals in a group chat tells sixteen
      // people about your deployment and helps none of them.
      await reply(message, inAudience
        ? "kuch toot gaya, baad me dekhta hoon"
        : `Something went wrong handling that: ${detail}`);
    } catch (replyError) {
      console.error("could not report the failure either:", replyError instanceof Error ? replyError.message : replyError);
    }
  });
});

/**
 * Write the groups this session can see back into the settings file, so
 * `tama settings` can offer them as a menu rather than asking for
 * 120363...@g.us. Only ids and names, and only groups: a dump of every private
 * chat would put the user's whole contact list in a config file.
 *
 * Called on connect and again whenever a message arrives from a group that is
 * not in the list yet. Without that second trigger, connecting a group meant
 * restarting the bridge, or reading an id out of this log and pasting it - both
 * of which are the deployment showing through the product.
 */
const published = new Set();

function rememberChat(id, name) {
  if (!id) return;
  // Re-record when a name turns up for a chat previously seen without one,
  // otherwise the first sighting decides forever.
  const key = `${id}\u0000${name ?? ""}`;
  if (published.has(key)) return;
  published.add(id);
  published.add(key);
  try {
    const file = patchSettings((f) => {
      const chats = Array.isArray(f.chats) ? f.chats : [];
      f.chats = [...chats.filter((c) => c.id !== id), { id, ...(name ? { name } : {}) }];
    });
    log("published", `${(file.chats ?? []).length} chats for tama settings to offer`);
  } catch (error) {
    console.error("could not record the chat:", error?.message ?? error);
  }
}

/**
 * Bulk on connect, one at a time thereafter.
 *
 * `client.getChats()` throws on some WhatsApp Web builds - it surfaced here as
 * "could not publish the chat list: r", a minified internal error - and it took
 * the whole list with it. Recording each chat as it is seen means one broken
 * call costs a menu that fills in as messages arrive, rather than a menu that
 * is empty forever.
 */
async function publishChats() {
  try {
    const chats = await client.getChats();
    for (const c of chats) {
      if (c.isGroup) rememberChat(c.id?._serialized, c.name);
    }
  } catch (error) {
    log("could not list chats in bulk, so groups will be recorded as they are seen", `(${error?.message ?? error})`);
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log("shutting down");
    client.destroy().finally(() => process.exit(0));
  });
}

watchSettings();
// A short hash of this file, so "did my change take effect" is answerable from
// the log instead of inferred from which lines are absent.
try {
  const own = readFileSync(new URL(import.meta.url));
  log("bridge", `build ${createHash("sha1").update(own).digest("hex").slice(0, 7)}`);
} catch { /* not worth failing a start over */ }
log("starting; first run prints a QR code");
clearStaleChromiumLocks(SESSION_DIR);
client.initialize();
