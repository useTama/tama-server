/**
 * `tama-server token NAME` — mint a device token.
 *
 * Every client needs one: the iOS Shortcut, the WhatsApp bridge, an MCP
 * client, a script. Until now the only ways to get one were the pairing QR
 * (built for a phone) and two curl calls against /pair, which is the plumbing
 * this project keeps deciding not to make people type.
 *
 * Owner tokens by default: unrestricted, like the machine it runs on. `--as
 * AUDIENCE` mints a scoped one instead, for a client that should only see a
 * slice of the vault.
 */

import { configPathFromArgs, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { mintToken } from "./auth.ts";
import { resolveView } from "./views.ts";
import { join } from "node:path";
import { bold, grey, ok, warn } from "./ui.ts";

export async function runToken(argv: string[] = Bun.argv): Promise<void> {
  const args = argv.slice(3);
  const flagIndex = args.indexOf("--as");
  const audience = flagIndex >= 0 ? args[flagIndex + 1] : undefined;
  const name = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--as" && args[i - 1] !== "--config");

  if (!name) {
    console.error("usage: tama-server token NAME [--as AUDIENCE]");
    console.error(grey("  e.g. tama-server token mcp-laptop"));
    process.exitCode = 2;
    return;
  }

  const configPath = configPathFromArgs(argv);
  const config = loadConfig(configPath);

  if (audience) {
    // Checked before minting, so a typo does not produce a token that every
    // request then refuses. /ask fails closed on an unknown audience, which
    // would otherwise look like a broken token rather than a wrong name.
    const known = config.audiences?.[audience];
    if (!known) {
      const names = Object.keys(config.audiences ?? {});
      console.error(`No audience called ${JSON.stringify(audience)}.${names.length ? ` known: ${names.join(", ")}` : ""}`);
      process.exitCode = 1;
      return;
    }
    resolveView(config.views, known.view);
  }

  const db = openDb(join(config.dataDir, "tama.db"));
  try {
    const { id, token } = mintToken(db, name, audience);
    console.log(ok(`Token for ${bold(name)}${audience ? ` as audience ${audience}` : ""}. Shown once.`));
    console.log(`\n  ${bold(token)}\n`);
    console.log(grey(`  id ${id}, revoke it under Devices in tama-server settings`));
    if (audience) {
      const a = config.audiences![audience]!;
      console.log(grey(`  sees ${a.view}, and cannot write`));
    } else {
      console.log(warn("  Unrestricted: the whole vault, and it can write."));
    }
  } finally {
    db.close();
  }
}
