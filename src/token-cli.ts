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
 *
 * ## Why the view flags imply their capability
 *
 * `--read-view work --write-view work-logs` is the shape people actually want,
 * and making them also type `--caps read,write` would be asking them to say the
 * same thing twice - then failing confusingly when they said it slightly
 * differently. So a view flag grants the capability it is a view *of*, and
 * `--caps` stays for the cases the flags cannot express: an ingest agent that
 * writes and may not read, or a token deliberately denied `ask`.
 *
 * The summary printed afterwards is not decoration. A token whose powers are
 * assembled from three flags is a token whose owner should be told what it can
 * do before they paste it somewhere.
 */

import { configPathFromArgs, loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { mintToken, type TokenScope } from "./auth.ts";
import { resolveView } from "./views.ts";
import { CAPABILITIES, parseCaps, resolveGrant, serialiseCaps, type Capability } from "./grants.ts";
import { join } from "node:path";
import { bold, grey, ok, warn } from "./ui.ts";

const FLAGS = ["--as", "--caps", "--read-view", "--write-view", "--config"] as const;

/** Flags take a value, so a positional is anything not a flag and not a flag's argument. */
function parseArgs(args: string[]): { name?: string; values: Record<string, string | undefined> } {
  const values: Record<string, string | undefined> = {};
  for (const flag of FLAGS) {
    const i = args.indexOf(flag);
    if (i >= 0) values[flag] = args[i + 1];
  }
  const name = args.find(
    (a, i) => !a.startsWith("--") && !(FLAGS as readonly string[]).includes(args[i - 1] ?? ""),
  );
  return { ...(name ? { name } : {}), values };
}

export async function runToken(argv: string[] = Bun.argv): Promise<void> {
  const args = argv.slice(3);
  const { name, values } = parseArgs(args);
  const audience = values["--as"];
  const readView = values["--read-view"];
  const writeView = values["--write-view"];

  if (!name) {
    console.error("usage: tama-server token NAME [--as AUDIENCE] [--caps LIST] [--read-view NAME] [--write-view NAME]");
    console.error(grey("  e.g. tama-server token mcp-laptop"));
    console.error(grey("       tama-server token agent --read-view work --write-view work-logs"));
    console.error(grey(`  capabilities: ${CAPABILITIES.join(", ")}`));
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

  // Same reason, for the same failure: an unknown view name minted into a token
  // is a 403 on every request that reads like a broken token.
  let caps: string | undefined;
  try {
    for (const view of [readView, writeView]) if (view) resolveView(config.views, view);
    if (values["--caps"] !== undefined) {
      parseCaps(values["--caps"]);
      caps = values["--caps"];
    } else if (readView || writeView) {
      // Derived, so the common case is two flags rather than three.
      const derived: Capability[] = [];
      if (readView) derived.push("read");
      if (writeView) derived.push("write");
      caps = serialiseCaps(new Set(derived)) ?? undefined;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    return;
  }

  const scope: TokenScope = {
    ...(audience ? { audience } : {}),
    ...(caps ? { caps } : {}),
    ...(readView ? { readView } : {}),
    ...(writeView ? { writeView } : {}),
  };

  const db = openDb(join(config.dataDir, "tama.db"));
  try {
    const { id, token } = mintToken(db, name, scope);
    console.log(ok(`Token for ${bold(name)}${audience ? ` as audience ${audience}` : ""}. Shown once.`));
    console.log(`\n  ${bold(token)}\n`);
    console.log(grey(`  id ${id}, revoke it under Credentials in tama-server settings`));

    // Resolved through the same code the server will use, so this describes the
    // token that now exists rather than the flags that were typed at it.
    const knownAudience = audience ? config.audiences?.[audience] : undefined;
    const grant = resolveGrant(
      { ...(caps ? { caps } : {}), ...(readView ? { readView } : {}), ...(writeView ? { writeView } : {}) },
      knownAudience
        ? { view: resolveView(config.views, knownAudience.view), capture: knownAudience.capture }
        : undefined,
      (n) => resolveView(config.views, n),
    );
    const allowed = CAPABILITIES.filter((c) => grant.caps.has(c));
    if (!audience && !caps && !readView && !writeView) {
      console.log(warn("  Unrestricted: the whole vault, and it can write."));
    } else {
      console.log(grey(`  may ${allowed.join(", ") || "nothing"}`));
      console.log(grey(`  reads ${readView ?? knownAudience?.view ?? "everything"}`));
      if (grant.caps.has("write")) console.log(grey(`  writes ${writeView ?? "anywhere"}`));
    }
  } finally {
    db.close();
  }
}
