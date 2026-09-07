/**
 * `tama-server settings` — change one thing without re-answering first-run setup.
 *
 * The wizard is a first-run flow: it walks vault, transcription, Ask and
 * WhatsApp in order because on a fresh install none of them exist yet. Once
 * they do, "add my other number to WhatsApp" should not mean arrowing past
 * eight unrelated questions, and it certainly should not mean hand-editing
 * .env or curling a pairing endpoint.
 *
 * Sections here own the files they change. Anything that would rewrite
 * tama.config.json hands off to the wizard instead, which already reads the
 * existing config as its defaults, rather than growing a second writer for it.
 */

import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configPathFromArgs, loadConfig } from "./config.ts";
import { bridgeSettings, runSetup, writeSettings, whatsappSenders, type BridgeSettings } from "./setup.ts";
import { BUILTIN_VIEWS, partitionByView, type View } from "./views.ts";
import type { Audience, Config } from "./config.ts";
import { listTokens, mintToken, revokeToken } from "./auth.ts";
import { openDb } from "./db.ts";
import { ask, choose, requireTty, yes } from "./prompt.ts";
import { tama, grey, bold, ok, warn } from "./ui.ts";

async function readBridge(path: string): Promise<BridgeSettings | undefined> {
  return readFile(path, "utf8")
    .then(text => JSON.parse(text) as BridgeSettings)
    .catch(() => undefined);
}

/**
 * Editing the bridge means editing exactly three things, and the third one is
 * the whole reason this section exists: the allowlist is what decides whether
 * your other phone can talk to it at all.
 */
async function bridgeSection(bridgePath: string, dbPath: string): Promise<void> {
  const current = await readBridge(bridgePath);

  // No settings file means one of two things, and neither is a dead end: the
  // bridge was never set up, or it predates this file and its token still lives
  // in .env. Both are answered by writing the file here.
  console.log(`\n${bold("WhatsApp bridge")}`);
  if (current) {
    console.log(`${grey("  your numbers:  ")} ${current.allowedFrom.length ? current.allowedFrom.join(", ") : grey("none besides the linked phone")}`);
    console.log(`${grey("  self-chat text: ")} ${current.selfChatText === "ask" ? "answered as a question" : `ignored unless prefixed with "${current.askPrefix}"`}`);
    console.log(`${grey("  device token:   ")} ${grey(`set, ${current.token.length} characters`)}`);
  } else {
    console.log(grey("  Not configured here yet. Answering these questions writes it,"));
    console.log(grey("  including a device token, so nothing needs pairing by hand."));
  }
  console.log(grey("  These are your own phones: they get the whole vault, like this one does."));
  console.log(grey("  Anyone else needs an audience, which is what decides what they can see."));

  let allowedFrom: string[] | null = null;
  do {
    const raw = await ask(
      current
        ? "Your own other numbers, comma-separated (Enter to keep, \"none\" to clear)"
        : "Your own other numbers, comma-separated (Enter for just this phone)",
      current?.allowedFrom.join(",") ?? "",
    );
    if (raw.trim().toLowerCase() === "none") allowedFrom = [];
    else if (!raw.trim()) allowedFrom = current?.allowedFrom ?? [];
    else allowedFrom = whatsappSenders(raw);
    if (!allowedFrom) console.log(warn("Use international numbers, digits only (a leading + is accepted)."));
  } while (!allowedFrom);

  const selfChatText = await choose("Plain text in your own chat with yourself", [
    { value: "ask" as const, label: "Answer it — the chat is your assistant" },
    { value: "ignore" as const, label: "Ignore it — the chat stays a scratchpad, a prefix asks" },
  ], current?.selfChatText ?? "ask");
  const askPrefix = selfChatText === "ignore"
    ? await ask("Prefix that marks a question there", current?.askPrefix || "?")
    : current?.askPrefix || "?";

  // With no token on file there is nothing to keep, so mint without asking.
  // When one exists, re-minting is the fix for a leak and is offered rather
  // than done: the old token keeps working until it is revoked, and swapping
  // silently would leave an unused one in the tokens table.
  let token = current?.token ?? "";
  const mint = !token || await yes("Mint a fresh device token for the bridge?", false);
  if (mint) {
    const db = openDb(dbPath);
    try {
      token = mintToken(db, "whatsapp-bridge").token;
      console.log(ok("Device token minted."));
      if (current?.token) console.log(grey("  The old one still works until you revoke it under Devices."));
    } finally {
      db.close();
    }
  }

  const next = bridgeSettings(token, allowedFrom, askPrefix, selfChatText, current ?? {});
  await writeSettings(bridgePath, next);
  console.log(ok(`Saved to ${bridgePath}.`));
  // Environment variables win over this file, so a pre-wizard install that
  // still sets them would quietly ignore everything just answered.
  console.log(warn("If TAMA_TOKEN or WA_ALLOWED are still in .env, remove them — they override this file:"));
  console.log(`  ${bold("sed -i '/^WA_ALLOWED=/d;/^TAMA_TOKEN=/d' .env")}`);
  console.log(`${bold("tama restart")} ${grey("or docker compose --profile whatsapp-webjs up -d, to apply it")}`);
}

/** The other half of a leaked token: seeing what exists and taking one away. */
async function devicesSection(dbPath: string): Promise<void> {
  const db = openDb(dbPath);
  try {
    const tokens = listTokens(db);
    if (tokens.length === 0) {
      console.log(warn("No devices are paired yet."));
      return;
    }
    console.log(`\n${bold("Devices")}`);
    for (const row of tokens) {
      console.log(`  ${row.device_name} ${grey(`${row.id}  paired ${row.created_at.slice(0, 10)}  ${row.last_used ? `last used ${row.last_used.slice(0, 10)}` : "never used"}`)}`);
    }
    if (!(await yes("Revoke one?", false))) return;
    const id = await ask("Device id to revoke", "");
    if (!id) return;
    console.log(revokeToken(db, id)
      ? ok(`Revoked ${id}. That device stops working immediately.`)
      : warn(`No device with id ${id}.`));
  } finally {
    db.close();
  }
}

/**
 * Every audience field is a menu, because #46's point is that nobody should
 * type a glob or a prompt into a settings screen. The freeform exception is
 * `note`, which carries facts about the room and never policy.
 */
async function editAudience(
  configPath: string,
  vaultPath: string,
  name: string,
  current: Audience | undefined,
  viewNames: string[],
): Promise<Audience> {
  // "Make a view first, then come back" is a dead end, and the menu is at its
  // emptiest exactly when someone is configuring their first audience.
  let view = await choose("What can it see?", [
    ...viewNames.map((v) => ({
      value: v,
      label: v === "none"
        ? "none — no notes at all, it can only talk"
        : v === "everything"
          ? "everything — the whole vault, like your own devices"
          : v,
    })),
    { value: "__new__", label: "something else — pick the folders now" },
  ], current?.view ?? "none");
  if (view === "__new__") {
    const viewName = (await ask("Name this slice of the vault (e.g. work, public)", "")).trim();
    if (!viewName || viewName in BUILTIN_VIEWS || !/^[a-z0-9][a-z0-9-]*$/i.test(viewName)) {
      console.log(warn("Needs a name of letters, digits and hyphens that is not a built-in. Falling back to none."));
      view = "none";
    } else {
      const saved = await editView(configPath, vaultPath, viewName, undefined);
      view = saved ? viewName : "none";
    }
  }

  const voice = await choose("How should it talk?", [
    { value: "friend" as const, label: "friend — a close friend with perfect recall, the default" },
    { value: "neutral" as const, label: "neutral — answers, no personality" },
    { value: "roast" as const, label: "roast — gives as good as it gets, for a group of friends" },
    { value: "custom" as const, label: "custom — describe it yourself" },
  ], current?.voice ?? "friend");

  let voicePrompt = current?.voicePrompt;
  if (voice === "custom") {
    console.log(grey("  One or two sentences on how it should talk. Tone only: it still cannot invent"));
    console.log(grey("  a memory, narrate its plumbing, or claim to have done something it cannot."));
    for (;;) {
      voicePrompt = (await ask("How should it talk?", voicePrompt ?? "")).trim();
      if (voicePrompt) break;
      console.log(warn("A custom voice needs a description, or pick one of the presets instead."));
    }
  }

  const length = await choose("How long should answers be?", [
    { value: "chat" as const, label: "chat — a couple of sentences, plain text" },
    { value: "prose" as const, label: "prose — full answers, markdown, for a terminal" },
  ], current?.length ?? "chat");

  // Defaulted from the view rather than asked blind: on anything but the
  // owner's own view a path names a note to someone who was not given it.
  const cite = view === "everything"
    ? await yes("Cite note paths in answers?", current?.cite ?? true)
    : false;
  if (view !== "everything") {
    console.log(grey("  Note paths are withheld: naming a file discloses it to a reader who was not shown it."));
  }

  const onNoMatch = await choose("When the notes have no answer", [
    { value: "say-so" as const, label: "say so — admit it, and never fill the gap" },
    { value: "just-talk" as const, label: "just talk — reply to what was said instead" },
  ], current?.onNoMatch ?? "say-so");
  if (onNoMatch === "just-talk" && view !== "none") {
    console.log(warn("  This mixes grounded and ungrounded answers in one chat, and a reader cannot tell which they got."));
    console.log(grey("  Fine for a banter group. For anything you rely on, prefer \"say so\"."));
  }

  const mention = await choose("In a group, when should it reply?", [
    { value: "when-mentioned" as const, label: "only when mentioned — quieter, harder to mute" },
    { value: "always" as const, label: "every message" },
  ], current?.mention ?? "when-mentioned");

  const note = await ask("One line about this room, or Enter for none", current?.note ?? "");

  const audience: Audience = {
    view, voice, length, cite, onNoMatch, mention,
    ...(voice === "custom" && voicePrompt ? { voicePrompt } : {}),
    // Never true. A group filling the vault with other people's chatter is the
    // failure the blanket group ignore was avoiding, and nothing here changes it.
    capture: false,
    ...(note.trim() ? { note: note.trim() } : {}),
  };

  await patchConfig(configPath, (raw) => {
    raw.audiences = { ...(raw.audiences ?? {}), [name]: audience };
  });
  console.log(ok(`Saved audience "${name}".`));
  return audience;
}

/**
 * A view is edited by picking folders that exist, with a count, because the
 * failure with a path filter is not writing it but being unable to see what it
 * did. Too narrow gives worse answers and no error; too wide leaks.
 */
async function editView(configPath: string, vaultPath: string, name: string, current: View | undefined): Promise<boolean> {
  const notes = await vaultNotes(vaultPath);
  const folders = [...new Set(notes.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : ".")))].sort();
  if (folders.length === 0) {
    console.log(warn("The vault has no notes yet, so there is nothing to preview a view against."));
  }

  const include: string[] = [];
  console.log(`\n${bold("Which top-level folders should it see?")} ${grey("one at a time, Enter to finish")}`);
  for (;;) {
    const remaining = folders.filter((f) => !include.includes(f === "." ? "*.md" : `${f}/**`));
    if (remaining.length === 0) break;
    const picked = await choose(include.length ? "Add another, or finish" : "Add a folder", [
      ...remaining.map((f) => ({ value: f, label: f === "." ? "notes in the vault root" : `${f}/` })),
      { value: "__done__", label: include.length ? "done" : "done (sees nothing)" },
    ], remaining[0]!);
    if (picked === "__done__") break;
    include.push(picked === "." ? "*.md" : `${picked}/**`);
  }

  const exclude: string[] = [];
  const raw = await ask("Anything to exclude inside those, comma-separated (e.g. **/Clients/**)", (current?.exclude ?? []).join(","));
  for (const glob of raw.split(",").map((g) => g.trim()).filter(Boolean)) exclude.push(glob);

  const view: View = { include, ...(exclude.length ? { exclude } : {}) };
  const { visible: shown, hidden } = partitionByView(notes, view);
  console.log(`\n${bold(`${shown.length} of ${notes.length} notes`)} ${grey("are visible through this view")}`);
  if (hidden.length) {
    const hiddenFolders = [...new Set(hidden.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "(root)")))].sort();
    console.log(`${grey("  hidden:")} ${hiddenFolders.slice(0, 8).join(", ")}${hiddenFolders.length > 8 ? ", …" : ""}`);
  }
  if (shown.length === 0) console.log(warn("  This view sees nothing. That is what \"none\" is for, unless you meant it."));

  if (!(await yes("Save this view?", true))) {
    console.log(grey("Discarded."));
    return false;
  }
  await patchConfig(configPath, (raw) => {
    raw.views = { ...(raw.views ?? {}), [name]: view };
  });
  console.log(ok(`Saved view "${name}".`));
  return true;
}

/**
 * Read, mutate, write atomically, preserving everything else in the file.
 *
 * Settings owns two keys in a config the wizard also writes, so it must not
 * rewrite the whole document from a parsed model: an unrelated field this
 * version does not know about would be dropped on save.
 */
async function patchConfig(configPath: string, mutate: (raw: any) => void): Promise<void> {
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  mutate(raw);
  const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, configPath);
}

/** Vault-relative note paths, for a view preview that reflects reality. */
async function vaultNotes(vaultPath: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const next = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(dir, e.name), next);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) out.push(next);
    }
  };
  await walk(vaultPath, "");
  return out.sort();
}

/** One row per audience, and a token minted per audience when it is saved. */
async function audiencesSection(configPath: string, dbPath: string, bridgePath: string, config: Config): Promise<void> {
  const audiences = config.audiences ?? {};
  const names = Object.keys(audiences);
  const viewNames = [...Object.keys(BUILTIN_VIEWS), ...Object.keys(config.views ?? {})];

  // Read here so the list can answer the question the old one could not: is
  // this audience actually reachable, and from where.
  const bridge = await readBridge(bridgePath);
  const chatName = (id: string) => bridge?.chats?.find((c) => c.id === id)?.name ?? id;

  console.log(`\n${bold("Audiences")}`);
  if (names.length === 0) {
    console.log(grey("  None yet. Your own devices need none: a token with no audience sees everything."));
  }
  for (const name of names) {
    const a = audiences[name]!;
    const wired = bridge?.audiences?.find((w) => w.name === name);
    const behaviour = [
      a.cite ? "cites paths" : "no paths",
      a.length,
      a.onNoMatch === "just-talk" ? "answers anything" : "admits gaps",
      a.mention === "when-mentioned" ? "when mentioned" : "every message",
    ].join(", ");
    const voice = a.voice === "custom" ? `custom: ${(a.voicePrompt ?? "").slice(0, 40)}` : a.voice;
    console.log(`  ${bold(name.padEnd(14))} ${grey(`sees ${a.view}`)}  ${voice}  ${grey(behaviour)}`);
    console.log(wired && wired.match.length > 0
      ? grey(`  ${" ".repeat(14)} in ${wired.match.map(chatName).join(", ")}`)
      : wired
        ? grey(`  ${" ".repeat(14)} waiting for a chat: send "/tama ${name}" in it`)
        : warn(`  ${" ".repeat(12)} no token yet, so nothing reaches it`));
  }

  if (bridge && (bridge.chats?.length ?? 0) === 0) {
    console.log(grey("\n  The WhatsApp bridge has not published a group list. Start it once and come"));
    console.log(grey("  back, and groups will be offered here by name."));
  }

  const pick = await choose("Which one?", [
    ...names.map((n) => ({ value: `edit:${n}`, label: `edit ${n}` })),
    { value: "add", label: "add an audience" },
    ...(names.length ? [{ value: "test", label: "test one — see what it would reply, without sending" }] : []),
    ...names.map((n) => ({ value: `remove:${n}`, label: `remove ${n}` })),
    { value: "back", label: "back" },
  ], names.length ? `edit:${names[0]}` : "add");

  if (pick === "back") return;

  if (pick === "test") {
    await testAudience(config, names);
    return;
  }

  if (pick.startsWith("remove:")) {
    const name = pick.slice("remove:".length);
    if (!(await yes(`Remove "${name}"? Its tokens stop working immediately.`, false))) return;
    await patchConfig(configPath, (raw) => { delete raw.audiences?.[name]; });
    // Not revoked here: the token rows stay visible under Devices so it is
    // obvious what was cut off, and /ask already refuses a token whose
    // audience is gone rather than falling back to the owner's view.
    console.log(ok(`Removed "${name}". Any token naming it is now refused.`));
    return;
  }

  const name = pick === "add"
    ? (await ask("Name it, for your own reference (e.g. work-group, the-boys)", "")).trim()
    : pick.slice("edit:".length);
  if (!name) return;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    console.log(warn("Use letters, digits and hyphens: this name goes in the config and on a token."));
    return;
  }

  const audience = await editAudience(configPath, config.vault.path, name, audiences[name], viewNames);

  const existing = await readBridge(bridgePath);
  const wired = existing?.audiences?.find((a) => a.name === name);
  const named = (id: string) => existing?.chats?.find((c) => c.id === id)?.name ?? id;

  // Connecting and re-issuing a token are separate questions. Asking one
  // question about both meant that declining to replace a working token also
  // declined to connect the audience at all, and nothing said so.
  const write = async (token: string, match: string[]) => {
    await writeSettings(bridgePath, {
      ...(existing ?? bridgeSettings("", [], "?")),
      audiences: [
        ...(existing?.audiences ?? []).filter((a) => a.name !== name),
        { name, token, match, mention: audience.mention },
      ],
    });
  };

  if (wired && wired.match.length > 0) {
    console.log(ok(`"${name}" is connected to ${wired.match.map(named).join(", ")}.`));
    if (await yes("Change which chats it answers in?", false)) {
      await write(wired.token, await pickChats(bridgePath, existing, name));
    } else {
      // Rewritten anyway: mention lives on this entry, and the answers above
      // may have changed it.
      await write(wired.token, wired.match);
    }
    if (await yes("Re-issue its token? Only needed if the old one leaked.", false)) {
      const db = openDb(dbPath);
      try {
        await write(mintToken(db, `audience:${name}`, name).token, wired.match);
        console.log(ok("New token issued. Revoke the old one under Devices."));
      } finally {
        db.close();
      }
    }
  } else if (await yes(`Connect "${name}" to a chat now?`, true)) {
    const db = openDb(dbPath);
    let token: string;
    try {
      token = wired?.token ?? mintToken(db, `audience:${name}`, name).token;
    } finally {
      db.close();
    }
    // Written straight into the bridge's settings rather than printed. A token
    // shown once and pasted by hand is the step this section exists to remove,
    // and it is also the step where a token ends up in a shell history.
    const match = await pickChats(bridgePath, existing, name);
    await write(token, match);
    if (match.length === 0) {
      // Written with no chats on purpose. An audience waiting to be claimed is
      // what makes the in-chat command work, and claiming it from the group is
      // the better path anyway: WhatsApp shows a group id nowhere.
      console.log(ok(`"${name}" is ready and waiting for a chat.`));
      console.log(`  In the group, send ${bold(`/tama ${name}`)}`);
      console.log(grey("  From your own number. That is the whole step: no ids, no coming back here."));
    } else {
      console.log(ok(`Connected "${name}" to ${match.map(named).join(", ")}.`));
      console.log(grey("  Its token is in the bridge's settings file. It cannot exceed this audience's"));
      console.log(grey("  view whatever the bridge asks for, because the server decides from the token."));
    }
  } else {
    console.log(warn(`"${name}" is saved but has no token, so nothing can reach it.`));
    console.log(grey("  Run this again and say yes to connect it."));
  }
  console.log(`${bold("tama restart")} ${grey("to apply it")}`);
}

/**
 * Which chats an audience answers in.
 *
 * Groups come from the list the bridge publishes on connect, because settings
 * runs in a container with no WhatsApp session and cannot reasonably ask
 * anyone to type 120363...@g.us. A number is still accepted by hand, since a
 * one-to-one chat that has never messaged you does not appear in any list.
 */
async function pickChats(
  bridgePath: string,
  existing: BridgeSettings | undefined,
  name: string,
): Promise<string[]> {
  const groups = existing?.chats ?? [];
  const current = existing?.audiences?.find((a) => a.name === name)?.match ?? [];
  const chosen: string[] = [];

  if (groups.length === 0) {
    console.log(grey("  No groups to offer yet: the bridge lists them once it has seen them."));
    console.log(grey("  Claiming from the group is usually easier anyway."));
  }

  const add = (value: string): void => {
    if (chosen.includes(value)) {
      console.log(grey(`  already added: ${value}`));
      return;
    }
    chosen.push(value);
    console.log(ok(`Added ${value}.`));
  };

  for (;;) {
    // Once something is chosen, finishing is the first option so Enter ends the
    // loop. Adding a second chat is the rare case and should not be the default
    // just because it happens to come later in a list.
    const done = {
      value: "__done__",
      label: chosen.length ? `done (${chosen.length} chat${chosen.length === 1 ? "" : "s"})` : "skip for now",
    };
    const rest = [
      ...groups
        .filter((g) => !chosen.includes(g.id))
        .map((g) => ({
          value: g.id,
          label: `${g.name || "unnamed group"}${current.includes(g.id) ? " (currently connected)" : ""}`,
        })),
      // A group cannot be expressed as a phone number, and a new group appears
      // in no published list until the bridge has seen it, so there has to be a
      // way to say one by hand.
      { value: "__claim__", label: `claim it from the group — send "/tama ${name}" there` },
      { value: "__number__", label: "a phone number, for a one-to-one chat" },
      { value: "__group__", label: "paste a group id (ends in @g.us)" },
    ];
    const options = chosen.length ? [done, ...rest] : [...rest, done];
    const picked = await choose(
      chosen.length ? `Connected to ${chosen.join(", ")}. Add another, or finish` : "Which chat is this audience?",
      options,
      options[0]!.value,
    );
    if (picked === "__done__" || picked === "__claim__") break;
    if (picked === "__group__") {
      console.log(grey("  A group id looks like 120363043211234567@g.us. In WhatsApp it is not shown"));
      console.log(grey("  anywhere, so the reliable way is to send one message in the group and read"));
      console.log(grey("  it off the bridge's own log, which prints the chat id of everything it sees."));
      const id = (await ask("Group id", "")).trim();
      if (!/^\d+@g\.us$/.test(id)) {
        console.log(warn("That is not a group id. They are digits followed by @g.us."));
        continue;
      }
      add(id);
      continue;
    }
    if (picked === "__number__") {
      const numbers = whatsappSenders(await ask("Number, country code and digits only", ""));
      if (!numbers) {
        console.log(warn("Use an international number, digits only."));
        continue;
      }
      for (const number of numbers) add(number);
      continue;
    }
    add(picked);
  }
  return chosen;
}

/**
 * The feature that makes the rest trustworthy.
 *
 * Per-audience scoping fails invisibly: a wrong view is not an error, it is an
 * answer someone should not have received. This runs a real question through an
 * audience's exact configuration and prints what it would have said.
 */
async function testAudience(config: Config, names: string[]): Promise<void> {
  const name = await choose("Test which audience?", names.map((n) => ({ value: n, label: n })), names[0]!);
  const audience = config.audiences?.[name];
  if (!audience) return;
  const question = await ask("Ask it something you would not want leaked", "what is Kiks Studios");
  if (!question.trim()) return;

  const { GrepRetriever } = await import("./retrieval.ts");
  const { resolveView } = await import("./views.ts");
  const { askOnce, systemPrompt } = await import("./ask.ts");

  const view = resolveView(config.views, audience.view);
  const retriever = new GrepRetriever(config.vault.path);
  const chunks = await retriever.search(question, config.ask?.maxChunks ?? 8, view);

  console.log(`\n${bold("What it can read for that question")}`);
  if (chunks.length === 0) console.log(grey("  nothing. Its reply comes from the voice alone."));
  for (const c of chunks) console.log(`  ${c.path}`);

  if (!config.ask) {
    console.log(warn("\nAsk is not configured, so the reply cannot be generated. The reading list above is still the answer to \"what can it see\"."));
    return;
  }
  if (!(await yes("\nGenerate the actual reply? (costs a model call)", true))) return;

  const { makeLlm } = await import("./llm.ts");
  const llm = config.ask.provider === "anthropic"
    ? makeLlm({ provider: "anthropic", apiKey: config.ask.apiKey, model: config.ask.model, maxTokens: config.ask.maxTokens })
    : makeLlm({ provider: "openai-compatible", baseUrl: config.ask.baseUrl!, apiKey: config.ask.apiKey, model: config.ask.model, maxTokens: config.ask.maxTokens });

  const result = await askOnce({
    question,
    retriever,
    llm,
    maxChunks: config.ask.maxChunks,
    view,
    prompt: {
      name: config.world?.name,
      voice: audience.voice,
      style: audience.length,
      cite: audience.cite,
      onNoMatch: audience.onNoMatch,
      note: audience.note,
    },
  });
  console.log(`\n${bold(`what "${name}" would receive`)}`);
  console.log(result.answer);
  console.log(grey("\nNothing was sent. If that reply says more than it should, narrow its view."));
  void systemPrompt;
}

async function viewsSection(configPath: string, config: Config): Promise<void> {
  const views = config.views ?? {};
  const names = Object.keys(views);
  console.log(`\n${bold("Views")}`);
  console.log(`  ${bold("everything".padEnd(14))} ${grey("the whole vault (built in)")}`);
  console.log(`  ${bold("none".padEnd(14))} ${grey("no notes at all (built in)")}`);
  for (const name of names) {
    const v = views[name]!;
    console.log(`  ${bold(name.padEnd(14))} ${grey(`${(v.include ?? ["**"]).join(" ")}${v.exclude?.length ? ` minus ${v.exclude.join(" ")}` : ""}`)}`);
  }

  const pick = await choose("Which one?", [
    ...names.map((n) => ({ value: `edit:${n}`, label: `edit ${n}` })),
    { value: "add", label: "add a view" },
    { value: "back", label: "back" },
  ], names.length ? `edit:${names[0]}` : "add");
  if (pick === "back") return;

  const name = pick === "add" ? (await ask("Name it (e.g. work, public)", "")).trim() : pick.slice("edit:".length);
  if (!name) return;
  if (name in BUILTIN_VIEWS) {
    console.log(warn(`"${name}" is built in and cannot be changed. That is deliberate: it is the one view that must never be wrong.`));
    return;
  }
  await editView(configPath, config.vault.path, name, views[name]);
}

export async function runSettings(argv: string[] = Bun.argv): Promise<void> {
  requireTty("settings");
  const configPath = configPathFromArgs(argv);
  if (!existsSync(configPath)) {
    console.log(warn(`No configuration at ${configPath}.`));
    console.log(grey("  Run tama-server setup first; settings edits an install that already exists."));
    return;
  }
  const initial = loadConfig(configPath);
  const bridgePath = resolve(dirname(configPath), "whatsapp-bridge.json");
  const dbPath = join(initial.dataDir, "tama.db");

  console.log(`\n${tama("Tama settings")} ${grey(configPath)}`);
  for (;;) {
    // Re-read every pass. Sections write to this file, so a config captured
    // once at startup goes stale the moment one saves - which showed up as
    // "Saved audience 315" followed by "None yet." on the next screen.
    let config: Config;
    try {
      config = loadConfig(configPath);
    } catch (e) {
      console.log(warn(`The config is no longer loadable: ${e instanceof Error ? e.message : e}`));
      console.log(grey("  Fix it, or re-run the full wizard. Nothing here can edit a file it cannot parse."));
      return;
    }

    const section = await choose("What would you like to change?", [
      { value: "audiences" as const, label: "Audiences — everyone who is not you: groups, other people" },
      { value: "views" as const, label: "Views — named slices of the vault, for audiences to see through" },
      { value: "bridge" as const, label: "WhatsApp bridge — your own numbers, self-chat behaviour, token" },
      { value: "devices" as const, label: "Devices — list what is paired, revoke one" },
      { value: "wizard" as const, label: "Everything else — vault, transcription, Ask (full setup)" },
      { value: "done" as const, label: "Done" },
    ], "audiences");

    if (section === "done") return;
    if (section === "wizard") {
      // Setup reads the saved config as its defaults, so this is a re-run and
      // not a reset. Duplicating its questions here would mean two writers for
      // one file and two places to keep in step.
      console.log(grey("\nRunning the full wizard. Enter keeps each saved answer.\n"));
      await runSetup(argv);
      return;
    }
    if (section === "audiences") await audiencesSection(configPath, dbPath, bridgePath, config);
    if (section === "views") await viewsSection(configPath, config);
    if (section === "bridge") await bridgeSection(bridgePath, dbPath);
    if (section === "devices") await devicesSection(dbPath);
  }
}
