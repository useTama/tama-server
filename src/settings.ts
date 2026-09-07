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
  if (!current) {
    console.log(warn("The WhatsApp bridge is not set up yet."));
    console.log(grey("  Run tama-server setup and pick \"Link your own WhatsApp number\" under WhatsApp."));
    return;
  }

  console.log(`\n${bold("WhatsApp bridge")}`);
  console.log(`${grey("  allowed numbers:")} ${current.allowedFrom.length ? current.allowedFrom.join(", ") : grey("none — only your own self-chat")}`);
  console.log(`${grey("  self-chat text: ")} ${current.selfChatText === "ask" ? "answered as a question" : `ignored unless prefixed with "${current.askPrefix}"`}`);
  console.log(`${grey("  device token:   ")} ${grey(`set, ${current.token.length} characters`)}`);

  let allowedFrom: string[] | null = null;
  do {
    const raw = await ask(
      "Numbers allowed to message it, comma-separated (Enter to keep, \"none\" to clear)",
      current.allowedFrom.join(","),
    );
    if (raw.trim().toLowerCase() === "none" || !raw.trim()) allowedFrom = raw.trim() ? [] : current.allowedFrom;
    else allowedFrom = whatsappSenders(raw);
    if (!allowedFrom) console.log(warn("Use international numbers, digits only (a leading + is accepted)."));
  } while (!allowedFrom);

  const selfChatText = await choose("Plain text in your own chat with yourself", [
    { value: "ask" as const, label: "Answer it — the chat is your assistant" },
    { value: "ignore" as const, label: "Ignore it — the chat stays a scratchpad, a prefix asks" },
  ], current.selfChatText ?? "ask");
  const askPrefix = selfChatText === "ignore"
    ? await ask("Prefix that marks a question there", current.askPrefix || "?")
    : current.askPrefix || "?";

  // Re-minting is the fix for a token that leaked or was revoked. It is offered
  // rather than done, because the old one keeps working until it is revoked and
  // silently swapping it would leave an unused token in the tokens table.
  let token = current.token;
  if (await yes("Mint a fresh device token for the bridge?", false)) {
    const db = openDb(dbPath);
    try {
      token = mintToken(db, "whatsapp-bridge").token;
      console.log(ok("New device token minted."));
      console.log(grey("  The old one still works until you revoke it under Devices."));
    } finally {
      db.close();
    }
  }

  const next = bridgeSettings(token, allowedFrom, askPrefix, selfChatText);
  await writeSettings(bridgePath, next);
  console.log(ok(`Saved to ${bridgePath}.`));
  console.log(`${bold("docker compose --profile whatsapp-webjs up -d")} ${grey("to apply it")}`);
  console.log(grey("  The bridge reads this file at startup, so it needs the restart."));
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
