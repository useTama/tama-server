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

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { configPathFromArgs, loadConfig } from "./config.ts";
import { bridgeSettings, runSetup, writeSettings, whatsappSenders, type BridgeSettings } from "./setup.ts";
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
    console.log(`${grey("  allowed numbers:")} ${current.allowedFrom.length ? current.allowedFrom.join(", ") : grey("none — only your own self-chat")}`);
    console.log(`${grey("  self-chat text: ")} ${current.selfChatText === "ask" ? "answered as a question" : `ignored unless prefixed with "${current.askPrefix}"`}`);
    console.log(`${grey("  device token:   ")} ${grey(`set, ${current.token.length} characters`)}`);
  } else {
    console.log(grey("  Not configured here yet. Answering these questions writes it,"));
    console.log(grey("  including a device token, so nothing needs pairing by hand."));
  }

  let allowedFrom: string[] | null = null;
  do {
    const raw = await ask(
      current
        ? "Numbers allowed to message it, comma-separated (Enter to keep, \"none\" to clear)"
        : "Numbers allowed to message it, comma-separated (Enter for only your own self-chat)",
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

  const next = bridgeSettings(token, allowedFrom, askPrefix, selfChatText);
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

export async function runSettings(argv: string[] = Bun.argv): Promise<void> {
  requireTty("settings");
  const configPath = configPathFromArgs(argv);
  if (!existsSync(configPath)) {
    console.log(warn(`No configuration at ${configPath}.`));
    console.log(grey("  Run tama-server setup first; settings edits an install that already exists."));
    return;
  }
  const config = await loadConfig(configPath);
  const bridgePath = resolve(dirname(configPath), "whatsapp-bridge.json");
  const dbPath = join(config.dataDir, "tama.db");

  console.log(`\n${tama("Tama settings")} ${grey(configPath)}`);
  for (;;) {
    const section = await choose("What would you like to change?", [
      { value: "bridge" as const, label: "WhatsApp bridge — allowed numbers, self-chat behaviour, token" },
      { value: "devices" as const, label: "Devices — list what is paired, revoke one" },
      { value: "wizard" as const, label: "Everything else — vault, transcription, Ask (full setup)" },
      { value: "done" as const, label: "Done" },
    ], "bridge");

    if (section === "done") return;
    if (section === "wizard") {
      // Setup reads the saved config as its defaults, so this is a re-run and
      // not a reset. Duplicating its questions here would mean two writers for
      // one file and two places to keep in step.
      console.log(grey("\nRunning the full wizard. Enter keeps each saved answer.\n"));
      await runSetup(argv);
      return;
    }
    if (section === "bridge") await bridgeSection(bridgePath, dbPath);
    if (section === "devices") await devicesSection(dbPath);
  }
}
