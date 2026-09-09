import { join } from "node:path";
import { watch } from "node:fs";
import { loadConfig, configPathFromArgs } from "./config.ts";
import { openDb } from "./db.ts";
import { Vault } from "./vault.ts";
import { Stt } from "./stt.ts";
import { ConsoleNotifier, NtfyNotifier, type Notifier } from "./notify.ts";
import { scheduleDigest } from "./digest.ts";
import { scheduleRouting } from "./route.ts";
import { GrepRetriever } from "./retrieval.ts";
import { makeLlm, type Llm } from "./llm.ts";
import { tama, grey, amber, green } from "./ui.ts";
import { safeNotify } from "./notify.ts";
import { recordFailure } from "./digest.ts";
import { sweepExpiredCodes } from "./auth.ts";
import * as idem from "./idempotency.ts";
import { createRoutes, VERSION } from "./routes.ts";

const configPath = configPathFromArgs(Bun.argv);
const config = loadConfig(configPath);
const db = openDb(join(config.dataDir, "tama.db"));
const vault = new Vault(config.vault.path, config.vault.inbox, config.safety.dryRun, config.safety.allowUnbackedVault);
const stt = new Stt(config.stt);

const notifier: Notifier =
  config.notify.provider === "ntfy"
    ? new NtfyNotifier(config.notify.ntfy.url, config.notify.ntfy.topic, config.notify.ntfy.token)
    : new ConsoleNotifier();

await vault.preflight();
sweepExpiredCodes(db);
idem.sweep(db);

if (!(await stt.health())) {
  recordFailure(db, { kind: "stt-down", detail: `unreachable at ${stt.endpoint} at startup` });
  safeNotify(notifier, {
    level: "error",
    title: "Tama: speech-to-text is down",
    message: `transcription unreachable at ${stt.endpoint}. Captures will fail until it is up.`,
  });
}

// Retrieval reads the vault directly and needs no model, so it exists whether or
// not anyone configured an LLM. The LLM is the optional half.
const retriever = new GrepRetriever(config.vault.path);
let llm: Llm | null = null;
if (config.ask) {
  try {
    llm =
      config.ask.provider === "anthropic"
        ? makeLlm({ provider: "anthropic", apiKey: config.ask.apiKey, model: config.ask.model, maxTokens: config.ask.maxTokens })
        : makeLlm({
            provider: "openai-compatible",
            baseUrl: config.ask.baseUrl!,
            apiKey: config.ask.apiKey,
            model: config.ask.model,
            maxTokens: config.ask.maxTokens,
          });
    console.log(`${grey("  ask    ")} ${llm.name}`);
  } catch (e) {
    // A broken ask config must not take capture down with it. Capture is the
    // free tier and has no dependency on any of this.
    console.error(`ask disabled: ${e instanceof Error ? e.message : String(e)}`);
    llm = null;
  }
}

let inflight = 0;
/**
 * Re-read the parts of the config that are only data.
 *
 * Audiences, views and the world's name are looked up per request, so a change
 * to them needs nothing rebuilt - and asking someone to restart the server to
 * add a phone number to a group is the deployment showing through the product.
 *
 * Deliberately partial. The stt client, the llm and the retriever are
 * constructed at boot from their config, and swapping those under live requests
 * is a different problem with a different failure mode. A provider change still
 * needs a restart, and the wizard says so.
 */
function watchConfig(): void {
  let pending: ReturnType<typeof setTimeout> | undefined;
  try {
    watch(configPath, () => {
      clearTimeout(pending);
      pending = setTimeout(() => {
        try {
          const next = loadConfig(configPath);
          const before = JSON.stringify({ a: config.audiences, v: config.views, w: config.world });
          config.audiences = next.audiences;
          config.views = next.views;
          config.world = next.world;
          if (JSON.stringify({ a: next.audiences, v: next.views, w: next.world }) === before) return;
          console.log(
            `${grey("config reloaded")} ${Object.keys(next.audiences ?? {}).length} audience(s), ` +
              `${Object.keys(next.views ?? {}).length} view(s)`,
          );
        } catch (e) {
          // A half-written file parses as garbage for a moment. Keeping the
          // last good copy is strictly better than failing requests.
          console.error("config reload failed, keeping the previous one:", e instanceof Error ? e.message : e);
        }
      }, 250);
    });
  } catch (e) {
    console.error("could not watch the config, so changes to audiences need a restart:", e instanceof Error ? e.message : e);
  }
}
watchConfig();

/**
 * Commit the vault shortly after it changes.
 *
 * Debounced rather than per write: a burst of captures, or an agent appending
 * three times while it finishes, should be one commit. Fifteen seconds is long
 * enough to coalesce a burst and short enough that a crash loses at most that.
 *
 * Fire and forget: a failing commit must never fail the write that triggered
 * it. The note is already on disk, which is the promise that matters.
 */
let commitTimer: ReturnType<typeof setTimeout> | undefined;
function commitSoon(): void {
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    void vault
      .commit()
      .then((r) => {
        if (r.committed) console.log(`${grey("committed")} ${r.detail}`);
      })
      .catch((e) => console.error("vault commit failed:", e instanceof Error ? e.message : e));
  }, 15_000);
  commitTimer.unref?.();
}

// A pending commit at shutdown would be lost, and the writes it covers would
// sit uncommitted until the next one. Flush instead.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearTimeout(commitTimer);
    void vault.commit().finally(() => process.exit(0));
  });
}

/**
 * The routes, given everything they need. index.ts is the process from here
 * down: construct, schedule, serve.
 */
const routes = createRoutes({ config, db, vault, stt, retriever, llm, notifier, onWrite: commitSoon });
routes.whatsapp?.start();

// `requestIP` is passed as a function rather than the server itself, so the
// handler has no way to reach into the runtime. It also has to be lazy: the
// server does not exist until Bun.serve returns.
const server: ReturnType<typeof Bun.serve> = Bun.serve({
  port: config.server.port,
  idleTimeout: 240,
  fetch: (req: Request): Promise<Response> => routes.handle(req, (r) => server.requestIP(r)?.address),
});

const stopDigest = scheduleDigest(db, notifier, config.notify.digestAt);
setInterval(() => { sweepExpiredCodes(db); idem.sweep(db); }, 3600_000).unref();

// Post-processing runs in the server process rather than a cron entry, because
// it needs the same vault, the same debounced commit and the same database as
// capture. Off unless configured: it rewrites notes.
const stopRouting = config.route?.enabled && llm
  ? scheduleRouting(
      { vault, db, llm, root: config.vault.path, inbox: config.vault.inbox, config: config.route, onWrite: commitSoon },
      (r) => {
        if (!r.filed.length && !r.failed.length && !r.nowUpdated) return;
        const parts = [`filed ${r.filed.length}`];
        if (r.unfiled.length) parts.push(`${r.unfiled.length} left`);
        if (r.failed.length) parts.push(`${r.failed.length} failed`);
        if (r.nowUpdated) parts.push(config.route!.nowNote);
        console.log(`${green("route")} ${grey(parts.join(", "))}`);
      },
    )
  : () => {};

console.log(`${tama("tama-server")} ${grey(VERSION)}   http://127.0.0.1:${server.port}`);
console.log(`${grey("  vault  ")} ${config.vault.path} -> ${config.vault.inbox}/`);
console.log(`${grey("  stt    ")} ${config.stt.url}${config.stt.model ? grey(` (${config.stt.model})`) : ""}`);
console.log(`${grey("  notify ")} ${notifier.name}, digest at ${config.notify.digestAt}`);
// Printed because getting it wrong is silent. A container has no timezone, so
// "local" is UTC, and a note captured at 1am IST was filed under the previous
// day for a month before anyone looked at a filename. The zone decides note
// names, the captured: stamp, what the model is told today is, and when the
// digest fires - so the banner states it next to the time it believes, where a
// wrong one is obvious at a glance.
{
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const local = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  console.log(`${grey("  time   ")} ${zone}, ${local} local${process.env.TZ ? "" : grey(" (TZ unset)")}`);
}
if (config.route?.enabled) {
  console.log(`${grey("  route  ")} every ${config.route.everyMinutes}m -> ${config.route.nowNote} ${grey(`(min confidence ${config.route.minConfidence})`)}`);
}
if (routes.whatsapp) {
  const callback = config.whatsapp!.publicBaseUrl
    ? `${config.whatsapp!.publicBaseUrl}/webhooks/whatsapp`
    : "/webhooks/whatsapp";
  console.log(`${grey("  whatsapp")} ${callback} (${config.whatsapp!.allowedFrom.length} allowed sender${config.whatsapp!.allowedFrom.length === 1 ? "" : "s"})`);
}
if (config.safety.dryRun) console.log(amber("  DRY RUN - nothing will be written"));

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  stopDigest();
  stopRouting();
  routes.whatsapp?.stop();
  db.close();
  server.stop(true);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
