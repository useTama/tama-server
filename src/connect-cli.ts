/**
 * `tama-server connect` — everything a client needs, as a line to paste.
 *
 * ## The four steps this replaces
 *
 * Setting up the editor plugin used to be four separate acts of assembly: mint
 * a token, copy it, work out for yourself which address the client should
 * dial, and compose the install command from a doc. Every one is a place
 * somebody stops, and the docs got one of them wrong for months - they told a
 * reader to run `tama token`, which does not exist on a laptop install, so the
 * first command after installing the plugin was a command-not-found.
 *
 * ## Why it prints rather than runs
 *
 * The client is installed on the machine the person WORKS on, and this command
 * runs wherever tama does. Those are often the same machine and sometimes not,
 * and this cannot tell. So it prints, and the person pastes.
 *
 * That has a real cost worth stating rather than hiding: a shell command
 * containing a token goes into shell history. The plugin marks the field
 * sensitive, which keeps it out of a settings file in the clear, and pasting
 * the install line defeats half of that. The alternative - print the two
 * values and make somebody type them into a dialog - is the thing that was
 * too many steps in the first place. So the tradeoff is named in the output
 * and the fix is `history -d` or a scoped token, not silence.
 */

import { configPathFromArgs, loadConfig, publicBaseUrl } from "./config.ts";
import { openDb } from "./db.ts";
import { mintToken } from "./auth.ts";
import { resolveView } from "./views.ts";
import { join } from "node:path";
import { bold, grey, ok, tama, warn } from "./ui.ts";

/** The clients that have an install line worth printing. */
const CLIENTS = ["claude-code", "claude-desktop"] as const;
type Client = (typeof CLIENTS)[number];

/**
 * Where a client should point, and how sure we are.
 *
 * Deliberately not asked for. The address is the step people get wrong,
 * because the right answer depends on where the client runs rather than on
 * anything about this machine - and the wrong answer produces a plugin that
 * installs cleanly and never connects.
 *
 * `publicBaseUrl` wins when it is set, because somebody set it on purpose.
 * Otherwise loopback, with the caveat attached rather than implied.
 */
export function clientAddress(publicBaseUrl: string | undefined, port: number): { url: string; loopback: boolean } {
  const configured = publicBaseUrl?.trim().replace(/\/+$/, "");
  if (configured) return { url: configured, loopback: false };
  return { url: `http://127.0.0.1:${port}`, loopback: true };
}

/** The lines to paste, for one client. */
export function installLines(client: Client, url: string, token: string): string[] {
  if (client === "claude-desktop") {
    return [
      "Download the bundle and double-click it, then fill in the two fields it asks for:",
      "",
      `  Tama server address   ${url}`,
      `  Device token          ${token}`,
      "",
      "The bundle is dist/tama.mcpb after `bun run pack:desktop`, or the",
      "tama.mcpb attached to the latest release.",
    ];
  }
  return [
    "Run these two lines on the machine you work on:",
    "",
    "  claude plugin marketplace add useTama/tama-server",
    "  claude plugin install tama@usetama --scope user \\",
    `    --config server_url=${url} \\`,
    `    --config device_token=${token}`,
  ];
}

export async function runConnect(argv: string[] = Bun.argv): Promise<void> {
  const args = argv.slice(3);
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--config" && args[i - 1] !== "--as");
  const client = (positional[0] ?? "claude-code") as Client;
  const flagIndex = args.indexOf("--as");
  const audience = flagIndex >= 0 ? args[flagIndex + 1] : undefined;

  if (!CLIENTS.includes(client)) {
    console.error(`usage: tama-server connect [${CLIENTS.join("|")}] [--as AUDIENCE]`);
    console.error(grey(`  no client called ${JSON.stringify(client)}`));
    process.exitCode = 2;
    return;
  }

  const config = loadConfig(configPathFromArgs(argv));

  if (audience) {
    // Checked before minting, for the same reason `token` checks it: a typo
    // otherwise mints a token that every request refuses, which reads as a
    // broken token rather than a wrong name.
    const known = config.audiences?.[audience];
    if (!known) {
      const names = Object.keys(config.audiences ?? {});
      console.error(`No audience called ${JSON.stringify(audience)}.${names.length ? ` known: ${names.join(", ")}` : ""}`);
      process.exitCode = 1;
      return;
    }
    resolveView(config.views, known.view);
    // Said before the install line, not after, because it changes whether the
    // client will work at all: append_note and record_session refuse a scoped
    // token, so an editor plugin holding one can read and cannot write.
    console.log(warn(`Scoped to audience ${audience}: this client will be able to read the vault and not write to it.`));
    console.log(grey("  The session-recording and note-writing tools refuse a scoped token by design.\n"));
  }

  const { url, loopback } = clientAddress(publicBaseUrl(config), config.server.port);
  const db = openDb(join(config.dataDir, "tama.db"));
  try {
    const { id, token } = mintToken(db, client, audience);
    console.log(ok(`Token for ${bold(client)}. Shown once.\n`));
    for (const line of installLines(client, url, token)) console.log(line);
    console.log("");

    if (loopback) {
      console.log(`That address is this machine's loopback, so it works if you are ${bold("on this machine")}.`);
      console.log(grey("  Running the client from another machine needs this one reachable from there:"));
      console.log(grey("    a tailnet    tama expose            (Docker deployments)"));
      console.log(grey("    an ssh tunnel scripts/tama-tunnel install USER@HOST"));
      console.log("");
    }

    console.log(grey(`Revoke it as ${id} under Credentials in ${tama("tama-server")} settings.`));
    console.log(grey("Pasting the line above puts the token in your shell history, which is the"));
    console.log(grey("cost of it being one paste. Clear that line, or mint a fresh token, if the"));
    console.log(grey("history is somewhere you would rather it were not."));
  } finally {
    db.close();
  }
}
