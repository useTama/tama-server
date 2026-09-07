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
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    askPrefix: process.env.WA_ASK_PREFIX || file.askPrefix || "?",
    // Answering is the default: a bot that stays silent when you talk to it
    // reads as broken, whatever the reasoning behind the silence.
    selfChatText: process.env.WA_SELF_CHAT_TEXT || file.selfChatText || "ask",
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

const settings = loadSettings();
const TAMA_TOKEN = settings.token;
const AUDIENCES = settings.audiences;
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
async function post(path, { headers = {}, body, token = TAMA_TOKEN }) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 5000 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${TAMA_URL}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, ...headers },
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
/** So the prefix hint is a note, not a nag. */
let toldAboutPrefix = false;

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
    log("media download failed", `attempt ${attempt + 1}: ${lastError?.message ?? lastError}`);
  }
  throw lastError ?? new Error("could not download the audio");
}

async function capture(message) {
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
 * The name to attribute a group message to.
 *
 * WhatsApp's push name is what the sender chose to be called, which is also
 * what everyone in the group sees, so it is the right handle for a reply that
 * names them. Falls back to the number, since a reply that says "someone" is
 * worse than one that says a number.
 */
async function speakerName(message, isOwner) {
  if (isOwner) return "you";
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
  if (message.id?._serialized && ours.has(message.id._serialized)) return;

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
  const audience = AUDIENCES.find((a) =>
    a.match.some((m) => m === chatId || ids.has(String(m).replace(/[^\d]/g, ""))),
  );

  // "Is this the owner", independent of which chat it arrived in. In a group
  // this is how a command is told apart from the other sixteen people talking.
  const isOwner = Boolean((selfNumber && ids.has(selfNumber)) || [...ids].some((id) => ALLOWED.has(id)) || (message.fromMe && isGroup));

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
  // token, the whole vault, and the self-chat text setting. Anybody who is not
  // the owner needs an audience, which is what decides what they may see.
  const isSelfChat = (selfNumber && ids.has(selfNumber))
    || chatId === selfId
    || [...ids].some((id) => ALLOWED.has(id));

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
    return askQuestion(message, text, audience, { name: await speakerName(message, isOwner), isOwner }, chatId);
  }



  if (isSelfChat && SELF_CHAT_TEXT === "ignore") {
    if (!text.startsWith(ASK_PREFIX)) {
      seen(`ignored, self-chat text without the "${ASK_PREFIX}" prefix`);
      // Said once per run, in the chat, because silence in your own chat with
      // your own assistant reads as broken however deliberate it is. The log
      // line above was the only signal, and nobody reads a log to find out why
      // their own bot ignored them.
      if (!toldAboutPrefix) {
        toldAboutPrefix = true;
        await reply(message, `put "${ASK_PREFIX}" in front to ask me something, or turn that off in tama settings under the whatsapp bridge`);
      }
      return;
    }
    const question = text.slice(ASK_PREFIX.length).trim();
    if (!question) {
      seen("ignored, prefix with no question after it");
      return;
    }
    seen("ask");
    return askQuestion(message, question, undefined, undefined, chatId);
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
    return askQuestion(message, question, undefined, undefined, chatId);
  }
  seen("ask");
  return askQuestion(message, text, undefined, undefined, chatId);
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
  log("your numbers", ALLOWED.size ? [...ALLOWED, selfNumber].join(", ") : `${selfNumber} (this phone only)`);
  log("self-chat text", SELF_CHAT_TEXT === "ask" ? "answered as a question" : `ignored unless prefixed with "${ASK_PREFIX}"`);
  for (const a of AUDIENCES) log("audience", a.name, `matches ${a.match.join(", ") || "nothing"}`, a.mention);
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
    const inAudience = AUDIENCES.some((a) => a.match.some((m) => m === chatId));
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

log("starting; first run prints a QR code");
clearStaleChromiumLocks(SESSION_DIR);
client.initialize();
