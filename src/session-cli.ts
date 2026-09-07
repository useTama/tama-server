/**
 * `tama-server session <project>` — record what a session did.
 *
 * Writes through the vault rather than through the HTTP route, for the same
 * reason `import` does: it works when the server is not running, and it needs
 * no token. The route exists for a client that is not on this machine.
 *
 * The summary comes from stdin, because the caller is usually an agent that
 * has just written one, and a shell argument is the wrong shape for a
 * paragraph. Flags carry the lists, which are short.
 */

import { loadConfig, configPathFromArgs } from "./config.ts";
import { Vault } from "./vault.ts";
import { appendSession } from "./session.ts";
import { ok, grey, warn } from "./ui.ts";

function flagValues(argv: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag && argv[i + 1] !== undefined) out.push(argv[i + 1]!);
  }
  return out;
}

export async function runSession(argv: string[] = Bun.argv): Promise<void> {
  const args = argv.slice(3);
  // First bare word that is not a flag's value. Walked rather than searched,
  // so `--shipped "PR #37" tama` finds tama and not "PR #37".
  let project: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      i++;
      continue;
    }
    project = a;
    break;
  }
  if (!project) {
    console.error("usage: tama-server session PROJECT [--shipped X] [--learned Y] [--next Z] < summary.md");
    process.exitCode = 2;
    return;
  }

  const config = loadConfig(configPathFromArgs(argv));
  const vault = new Vault(
    config.vault.path,
    config.vault.inbox,
    config.safety.dryRun,
    config.safety.allowUnbackedVault,
  );
  await vault.preflight();

  // Not a TTY means a pipe, which is the intended use. A person running this
  // by hand gets told rather than left waiting on a stdin that never closes.
  let summary = "";
  if (!process.stdin.isTTY) summary = await new Response(Bun.stdin.stream()).text();

  const shipped = flagValues(args, "--shipped");
  const learned = flagValues(args, "--learned");
  const next = flagValues(args, "--next");

  if (!summary.trim() && shipped.length + learned.length + next.length === 0) {
    console.error(warn("Nothing to record."));
    console.error(grey('  pipe a summary in: echo "fixed the mention detection" | tama-server session tama'));
    console.error(grey("  or pass lists:     tama-server session tama --shipped \"PR #37\" --next \"scoped tokens\""));
    process.exitCode = 2;
    return;
  }

  const result = await appendSession(vault, { project, summary, shipped, learned, next });
  console.log(`${ok(result.created ? "Started" : "Appended to")} ${result.relPath} ${grey(`${result.bytes}B`)}`);
  console.log(grey("  ask about it later: \"what have I been doing on " + project + "\""));
}
