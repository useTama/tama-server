/**
 * `tama-server route` - run one post-processing cycle now.
 *
 * The cycle normally runs on a timer inside the server. This exists because
 * "wait fifteen minutes and read the log" is not a way to find out whether
 * filing works, or to watch what a model decided about your own notes. It is
 * also the whole feature for anyone who would rather run it by hand.
 *
 * `--dry-run` prints the decisions and writes nothing, which is the honest way
 * to try this on a vault you care about before letting a timer near it.
 */
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { Vault } from "./vault.ts";
import { makeLlm } from "./llm.ts";
import { ROUTE_DEFAULTS, routeOnce, stuck, waiting } from "./route.ts";
import { grey, green, amber, warn, ok, tama } from "./ui.ts";

function configPathFromArgs(argv: string[]): string | undefined {
  const i = argv.indexOf("--config");
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function runRoute(argv: string[] = Bun.argv): Promise<void> {
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");
  const config = loadConfig(configPathFromArgs(argv));

  if (!config.ask) {
    throw new Error("no ask block in the config, and filing a capture needs the model. Run tama-server setup");
  }
  // Deliberately runs even when route.enabled is false. Trying it by hand is
  // how someone decides whether to turn the timer on at all.
  const routeConfig = config.route ?? { ...ROUTE_DEFAULTS, enabled: false };

  const llm =
    config.ask.provider === "anthropic"
      ? makeLlm({ provider: "anthropic", apiKey: config.ask.apiKey, model: config.ask.model, maxTokens: config.ask.maxTokens })
      : makeLlm({
          provider: "openai-compatible",
          baseUrl: config.ask.baseUrl!,
          apiKey: config.ask.apiKey,
          model: config.ask.model,
          maxTokens: config.ask.maxTokens,
        });

  const vault = new Vault(config.vault.path, config.vault.inbox, dryRun || config.safety.dryRun, config.safety.allowUnbackedVault);
  await vault.preflight();
  const db = openDb(join(config.dataDir, "tama.db"));

  const inboxNow = await waiting(config.vault.path, config.vault.inbox);
  console.log(`\n${tama("Filing")} ${grey(`${config.vault.path}/${config.vault.inbox}`)}`);
  console.log(`${grey("  model  ")} ${llm.name}`);
  console.log(`${grey("  waiting")} ${inboxNow.length} capture${inboxNow.length === 1 ? "" : "s"}`);
  if (dryRun || config.safety.dryRun) console.log(amber("  DRY RUN - deciding only, nothing will be written"));
  console.log("");

  try {
    const report = await routeOnce({
      vault, db, llm,
      root: config.vault.path,
      inbox: config.vault.inbox,
      config: { ...routeConfig, maxPerSweep: Math.max(routeConfig.maxPerSweep, inboxNow.length) },
    });

    for (const f of report.filed) {
      console.log(`${green(f.created ? "created" : "filed  ")} ${f.destination} ${grey(`<- ${f.capture}`)}`);
    }
    for (const u of report.unfiled) console.log(`${grey("left   ")} ${u.capture} ${grey(`(${u.why})`)}`);
    for (const f of report.failed) console.log(`${amber("failed ")} ${f.capture} ${grey(`(${f.why})`)}`);
    if (report.nowUpdated) console.log(`${green("updated")} ${routeConfig.nowNote}`);

    console.log("");
    if (!report.filed.length && !report.unfiled.length && !report.failed.length) {
      console.log(ok("Nothing to file."));
    } else {
      console.log(ok(`${report.filed.length} filed, ${report.unfiled.length} left, ${report.failed.length} failed.`));
    }
    if (report.remaining) console.log(grey(`  ${report.remaining} more waiting for the next pass.`));

    // The ones a human has to look at, named, because the alternative is
    // noticing months later that the Inbox never quite empties.
    const givenUp = stuck(db, routeConfig.maxTries);
    if (givenUp.length) {
      console.log(warn(`${givenUp.length} capture${givenUp.length === 1 ? "" : "s"} routing has given up on:`));
      for (const s of givenUp.slice(0, 10)) console.log(grey(`  ${s.relPath} - ${s.why}`));
      console.log(grey("  File them by hand, or delete them. They are no longer being tried."));
    }
  } finally {
    db.close();
  }
}
