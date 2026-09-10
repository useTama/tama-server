import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "./vault.ts";
import { assertSeparateImportRoots, collectMarkdown, importMarkdownFolder } from "./import.ts";
import { configPathFromArgs, loadConfig } from "./config.ts";
import { Stt, SPEECH_MODEL, SARVAM_URL, SARVAM_DEFAULT_MODEL, type SttConfig } from "./stt.ts";
import * as whisper from "./whisper.ts";
import { red, grey, bold, ok, warn, card } from "./ui.ts";
import { coverPage, frameWidth, page, type Step } from "./screen.ts";
import { ask, choose, endpoint, navigate, optionalPublicOrigin, requireTty, secret, yes } from "./prompt.ts";

type AskConfig =
  | undefined
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKeyEnv?: string; maxChunks: number };

/**
 * What the whatsapp-web.js bridge reads. It is a client, so this is not part of
 * `tama.config.json`: the server has no opinion about the bridge existing, and
 * the file lives beside the config only because that directory is already the
 * one mounted into containers.
 */
export type BridgeSettings = {
  token: string;
  /** The owner's other numbers. Treated as the owner, not as guests. */
  allowedFrom: string[];
  /**
   * One entry per audience the bridge answers as, each holding the token minted
   * for it. The bridge decides which entry a message belongs to and nothing
   * else: the server derives the view, voice and flags from the token, so a
   * wrong match rule misroutes a question without widening what it can read.
   */
  audiences?: Array<{ name: string; token: string; match: string[]; mention: "always" | "when-mentioned" | "in-conversation" }>;
  /**
   * Groups this WhatsApp session can see, written by the bridge on connect so
   * `tama settings` can offer them as a menu. Settings has no session of its
   * own and cannot ask anyone to type a group id.
   */
  chats?: Array<{ id: string; name?: string }>;
};

/** Written 0600 and replaced atomically, because it holds a device token. */
export async function writeSettings(path: string, settings: BridgeSettings): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export function bridgeSettings(
  token: string,
  allowedFrom: string[],
  rest: Partial<Pick<BridgeSettings, "audiences" | "chats">> = {},
): BridgeSettings {
  // An empty allowlist is meaningful rather than missing: it means nobody but
  // you, in your own chat with yourself.
  // Audiences and the published chat list survive an edit to the owner's own
  // settings: the bridge section rewrites this file, and dropping them would
  // silently disconnect every group and empty the menu that connects them.
  return {
    token,
    allowedFrom,
    ...(rest.audiences ? { audiences: rest.audiences } : {}),
    ...(rest.chats ? { chats: rest.chats } : {}),
  };
}

/** What setup can produce. `apiKey` is never one of them: it goes to its own file. */
export type SttAnswer = Omit<SttConfig, "apiKey">;

export type WhatsAppAnswer = {
  phoneNumberId: string;
  allowedFrom: string[];
  graphApiVersion: string;
  publicBaseUrl?: string;
};

export type SetupAnswers = {
  vaultPath: string;
  inbox: string;
  /** Absent when the caller is not asking about transcription; the saved block stands. */
  stt?: SttAnswer;
  port: number;
  ask: AskConfig;
  whatsapp?: WhatsAppAnswer;
};

type VaultPlan = "create" | "use-existing";

export async function vaultPlan(path: string): Promise<VaultPlan> {
  if (!existsSync(path)) return "create";
  const entries = await readdir(path);
  if (entries.length === 0) return "create";
  if (entries.includes(".git")) return "use-existing";
  throw new Error("vault exists but is not git-tracked; choose a new empty folder or initialize this vault manually");
}

export function configFromAnswers(a: SetupAnswers): Record<string, unknown> {
  return {
    vault: { path: a.vaultPath, inbox: a.inbox },
    ...(a.stt ? { stt: a.stt } : {}),
    server: { port: a.port, adminToken: randomBytes(24).toString("hex") },
    notify: { provider: "console", ntfy: { url: "https://ntfy.sh", topic: "" }, digestAt: "08:00" },
    safety: { allowUnbackedVault: false, dryRun: false },
    ...(a.ask ? { ask: a.ask } : {}),
    ...(a.whatsapp ? { whatsapp: a.whatsapp } : {}),
    // A container deployment mounts its own volumes, and the wizard running
    // inside it must write those paths rather than a home directory that does
    // not survive the container.
    dataDir: process.env.TAMA_DATA_DIR ?? "~/.local/share/tama",
  };
}

/** The OpenAI-compatible listing both the ask and the stt flows shop from. */
/** Exported so `tama-server settings` lists models the same way setup does. */
export async function listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json() as { data?: { id: string }[] };
  return body.data?.filter(m => typeof m.id === "string").map(m => m.id) ?? [];
}

function homePath(suffix: string): string {
  return `${process.env.HOME ?? "~"}${suffix}`;
}

export function worldFolder(name: string): string {
  const folder = name.normalize("NFKC").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "-").replace(/^\.+|\.+$/g, "").trim();
  return folder.slice(0, 80) || "My World";
}

export function whatsappSenders(value: string): string[] | null {
  const senders = [...new Set(value.split(/[\s,]+/).map((item) => item.replace(/^\+/, "")).filter(Boolean))];
  return senders.length > 0 && senders.every((item) => /^\d{6,20}$/.test(item)) ? senders : null;
}

/**
 * Which of the wizard's blocks to walk.
 *
 * `tama settings` owns transcription and Ask as their own sections, so the
 * "everything else" entry there would otherwise make you re-answer both -
 * provider, key, model, language - just to rename your world. A block left out
 * is not a block reset: the saved one is carried through untouched.
 */
export type SetupScope = { stt?: boolean; ask?: boolean; whatsapp?: boolean };

/**
 * The wizard, as pages.
 *
 * Each block below is one screen: it draws the frame, asks its questions, and
 * hands back to the driver at the bottom of the page. The driver is what makes
 * Back work — every answer lives in `draft` rather than in a local variable
 * halfway down a single long function, so returning to a page re-asks its
 * questions with what you last said as the default, and nothing is written
 * until the review page is confirmed.
 */
export async function runSetup(argv: string[] = Bun.argv, scope: SetupScope = {}): Promise<void> {
  requireTty("setup");
  const walkStt = scope.stt !== false;
  const walkAsk = scope.ask !== false;
  const walkWhatsApp = scope.whatsapp !== false;
  const partial = !walkStt || !walkAsk || !walkWhatsApp;
  const configPath = configPathFromArgs(argv);
  /**
   * Install check, model, service. Returns whether the server ended up
   * answering; every exit is a soft one, because a saved config plus a manual
   * whisper is still a working install.
   */
  const bootstrapWhisper = async (url: string, probe: () => Promise<boolean>): Promise<boolean> => {
    const binary = whisper.serverBinary();
    if (!binary) {
      console.log(warn(`whisper.cpp is not installed. ${grey(whisper.installHint())}`));
      return false;
    }
    let models = await whisper.installedModels();
    if (models.length === 0) {
      const file = await choose("Which model should Tama download?", whisper.MODELS, whisper.MODELS[0]!.value);
      console.log(grey(`Downloading ${file} to ${whisper.MODEL_DIR} — this is a one-time download.`));
      try {
        let shown = -1;
        await whisper.downloadModel(file, (fraction) => {
          const percent = Math.floor(fraction * 100);
          if (percent === shown) return;
          shown = percent;
          output.write(`\r\x1b[2K  ${red("█".repeat(Math.round(percent / 4)))}${grey("░".repeat(25 - Math.round(percent / 4)))} ${percent}%`);
        });
        output.write("\n");
        console.log(ok("Model downloaded."));
      } catch (error) {
        output.write("\n");
        console.log(warn(`Could not download the model: ${error instanceof Error ? error.message : "unknown error"}`));
        return false;
      }
      models = await whisper.installedModels();
    }
    const model = models.length === 1
      ? models[0]!
      : await choose("Which model should Whisper serve?", models.map((m) => ({ value: m, label: m })), models[0]!);

    const port = Number(new URL(url).port || "8081");
    const service = whisper.serviceFor(binary, `${whisper.MODEL_DIR}/${model}`, port);
    if (!service) {
      console.log(warn(`No service template for this platform. Start it yourself: ${grey(`${binary} -m ${whisper.MODEL_DIR}/${model} --host 127.0.0.1 --port ${port}`)}`));
      return false;
    }
    if (!(await yes(`Keep Whisper running in the background? ${grey(`(writes ${service.path})`)}`, true))) return false;
    const failure = await whisper.installService(service);
    if (failure) {
      console.log(warn(`Could not start the Whisper service: ${failure}`));
      return false;
    }
    console.log(grey("Waiting for Whisper to load the model…"));
    const running = await whisper.waitForHealth(probe);
    console.log(running
      ? ok(`Whisper is running and will start again at login. ${grey(`Stop it with: ${service.stop}`)}`)
      : warn(`The Whisper service was installed but is not answering yet. ${grey(service.path)}`));
    return running;
  };
  try {
    // ffmpeg is not optional for audio, and finding that out at the first
    // recording instead of here costs a thought. git is what makes a vault a
    // vault, so its absence is fatal rather than a warning.
    if (!Bun.which("git")) throw new Error(`git is not installed. A Tama vault is a git repository.\n  ${process.platform === "darwin" ? "brew install git" : "apt install git"}`);
    const existing = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : undefined;
    const current = existing ? loadConfig(configPath) : undefined;
    const bridgePath = resolve(dirname(configPath), "whatsapp-bridge.json");
    // This is application state, not a choice most people need to make. Keep
    // it in the standard per-user location; deployments can still set
    // TAMA_CONFIG explicitly without going through the interactive wizard.
    const port = current?.server.port ?? 8080;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("server port must be between 1 and 65535");

    /**
     * Every answer the wizard has collected so far. A page reads it for its
     * defaults and overwrites its own fields, which is what lets you walk back
     * into a page and change your mind: there is one copy of each answer, and
     * it belongs to the run rather than to a line of code.
     */
    const draft: {
      worldName: string;
      vaultPath: string;
      plan: VaultPlan;
      importSource?: string;
      importNoteCount: number;
      stt?: SttAnswer;
      sttKey?: string;
      ask: AskConfig;
      askKey?: string;
      askChoice: string;
      whatsapp?: WhatsAppAnswer;
      whatsappAccessToken?: string;
      whatsappAppSecret?: string;
      whatsappVerifyToken?: string;
      bridge?: BridgeSettings;
    } = {
      worldName: existing?.world?.name ?? "My World",
      vaultPath: "",
      plan: "create",
      importNoteCount: 0,
      ask: undefined,
      askChoice: "unchanged",
    };

    /**
     * A path with `$HOME` folded back to `~`. Cards clamp to the frame width, so
     * a full home path is what pushes a vault location into an ellipsis — and
     * the one line the user most needs to read is the one they cannot check.
     */
    const short = (path: string): string => {
      const home = process.env.HOME;
      return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
    };

    const steps: Step[] = [
      { key: "world", title: "World", blurb: "What this Tama is called." },
      { key: "vault", title: "Vault", blurb: "The git-tracked folder your notes are written into." },
      ...(walkStt ? [{ key: "voice", title: "Voice", blurb: "Who turns a recording into text. Skippable — everything but voice works without it." }] : []),
      ...(walkAsk ? [{ key: "ask", title: "Ask", blurb: "Which model answers questions about your notes. Optional." }] : []),
      ...(walkWhatsApp ? [{ key: "whatsapp", title: "WhatsApp", blurb: "Capture from a chat, and answer questions there. Optional." }] : []),
      { key: "review", title: "Review", blurb: "Everything this run is about to write, before it writes any of it." },
    ];

    const worldPage = async () => {
      draft.worldName = await ask("What would you like to name your world?", draft.worldName);
    };

    const vaultPage = async () => {
      const suggested = draft.vaultPath || current?.vault.path || process.env.TAMA_VAULT || homePath(`/Tama/${worldFolder(draft.worldName)}`);
      console.log(`  Your notes will be saved in ${bold(short(suggested))}`);
      let askLocation = await yes("Choose a different location?");
      for (;;) {
        const entered = askLocation ? await ask("Folder for your world", suggested) : suggested;
        const candidate = resolve(entered.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        try {
          draft.plan = await vaultPlan(candidate);
          draft.vaultPath = candidate;
          break;
        } catch {
          console.log(warn("Choose an empty folder or an existing git-backed vault. Your existing notes will not be changed."));
          askLocation = true;
        }
      }

      // Walking back into this page and choosing "start without importing" has
      // to actually drop the import, so the answer is cleared before it is
      // asked again rather than carried by whichever branch happens to run.
      draft.importSource = undefined;
      draft.importNoteCount = 0;
      const importChoice = await choose("Existing notes", [
        { value: "none", label: draft.plan === "create" ? "Start without importing notes" : "Keep this Tama vault as-is" },
        { value: "obsidian", label: "Import an Obsidian / Markdown second brain" },
      ], "none");
      if (importChoice !== "obsidian") return;
      console.log(grey("  Choose a folder on this machine. Tama reads UTF-8 Markdown only, preserves note folders, and never modifies the source."));
      console.log(grey("  Use a separate local Tama vault; attachments and hidden Obsidian settings are not copied."));
      for (;;) {
        const entered = await ask("Obsidian vault or Markdown folder", "");
        if (!entered) {
          console.log(warn("Enter the folder containing your Markdown notes."));
          continue;
        }
        const candidate = resolve(entered.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        try {
          await assertSeparateImportRoots(candidate, draft.vaultPath);
          const notes = await collectMarkdown(candidate);
          if (notes.length === 0) throw new Error("no Markdown notes found");
          draft.importSource = candidate;
          draft.importNoteCount = notes.length;
          console.log(ok(`Found ${notes.length} Markdown note${notes.length === 1 ? "" : "s"} to import.`));
          break;
        } catch (error) {
          console.log(warn(`Cannot use that folder: ${error instanceof Error ? error.message : "unknown error"}.`));
        }
      }
    };

    const voicePage = async () => {
      // A key typed on an earlier visit belonged to whichever provider was
      // chosen then. Keeping it would attach a Groq key to a Sarvam endpoint,
      // so this page re-earns it.
      draft.sttKey = undefined;
      // Three answers, two wire formats. "Here" and "elsewhere" differ only in
      // whether a key is likely, but they are separate lines because "where is
      // whisper running" is the question the user can actually answer.
      const sttChoice = await choose("Speech-to-text", [
        { value: "api", label: "A transcription API (Groq, OpenAI, Sarvam, …)" },
        { value: "here", label: "Whisper on this machine (private; needs CPU and a model download)" },
        { value: "remote", label: "Whisper on another machine" },
        // The answer that was missing, and the one somebody setting this up to
        // read notes in an editor actually wants. Without it, all three
        // choices demanded either a key or a whisper endpoint, and the first -
        // which is the default - abandons the whole wizard when there is no
        // key. So a person who came to search their own notes could not finish
        // setup at all, in a project whose README says capture needs no
        // account.
        { value: "later", label: "Not yet — text notes and the editor plugin, no voice" },
      ], draft.stt?.provider === "whisper-cpp" || current?.stt.provider === "whisper-cpp" ? "here" : "api");

      if (sttChoice === "later") {
        console.log(grey("  Skipping transcription. Everything that is not voice still works:"));
        console.log(grey("    text captures, search, the editor plugin, and recording a session."));
        console.log(grey("    Sending a voice note will fail until you set this up, and /health says so."));
        console.log(grey(`    Come back to it with ${bold("tama-server settings")} whenever.`));
        // config.ts's own default, left deliberately unreachable rather than
        // absent: /health then reports stt false and a voice capture fails
        // naming the endpoint it tried, instead of failing with no config to
        // point at.
        draft.stt = { provider: "whisper-cpp", url: "http://127.0.0.1:8081" };
      } else if (sttChoice === "api") {
        const providers = [
          { value: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", keys: "https://console.groq.com/keys" },
          { value: "openai", label: "OpenAI", url: "https://api.openai.com/v1", keys: "https://platform.openai.com/api-keys" },
          { value: "sarvam", label: "Sarvam (Indian languages, code-mixed speech)", url: SARVAM_URL, keys: "https://dashboard.sarvam.ai" },
        ];
        const chosen = await choose("Choose your transcription provider", [
          ...providers,
          { value: "custom", label: "Custom provider (OpenAI-compatible /audio/transcriptions)" },
        ], current?.stt.provider === "sarvam" ? "sarvam" : "groq");
        const preset = providers.find(p => p.value === chosen);
        console.log(warn("Your recordings will be uploaded to this provider."));
        if (preset) console.log(`${grey("  Get your API key:")} ${preset.keys}`);
        const baseUrl = preset?.url ?? await endpoint("Provider address", "");
        draft.sttKey = current?.stt.url === baseUrl ? current.stt.apiKey : undefined;
        draft.sttKey = await secret(draft.sttKey ? "API key (Enter to keep saved key)" : "API key") || draft.sttKey;
        while (!draft.sttKey) {
          console.log(warn("A hosted transcription provider needs an API key."));
          if (!(await yes("Enter an API key now?", true))) {
            // Fall back rather than abandon. Throwing away every answer given
            // so far because one optional feature has no key is the wrong
            // trade: the vault, the admin token and everything else were
            // already decided, and voice is the only thing this costs.
            console.log(grey("  Carrying on without transcription. Text notes, search and the editor"));
            console.log(grey("  plugin all work; voice does not until you add a key in settings."));
            draft.stt = { provider: "whisper-cpp", url: "http://127.0.0.1:8081" };
            draft.sttKey = undefined;
            return;
          }
          draft.sttKey = await secret("API key");
        }
        if (chosen === "sarvam") {
          // Sarvam publishes no model listing to shop from, and has two models
          // worth offering, so this menu is the documented set, not a discovery call.
          const model = await choose("Choose a Sarvam model", [
            { value: "saaras:v3", label: "saaras:v3 (default)" },
            { value: "saaras:v4", label: "saaras:v4 (newer)" },
          ], current?.stt.model ?? SARVAM_DEFAULT_MODEL);
          // Sarvam takes a spoken-language hint that whisper infers for itself.
          const language = await choose("Spoken language", [
            { value: "unknown", label: "Detect automatically" },
            { value: "en-IN", label: "English (India)" },
            { value: "hi-IN", label: "Hindi" },
            { value: "bn-IN", label: "Bengali" },
            { value: "ta-IN", label: "Tamil" },
            { value: "te-IN", label: "Telugu" },
            { value: "mr-IN", label: "Marathi" },
            { value: "kn-IN", label: "Kannada" },
          ], current?.stt.language ?? "unknown");
          draft.stt = { provider: "sarvam", url: baseUrl, model, language };
          // No unauthenticated listing route exists here, so this is reachability
          // only. A wrong key first shows up on the first capture, not now.
          console.log(await new Stt({ ...draft.stt, apiKey: draft.sttKey }).health()
            ? ok(`Sarvam reachable ${grey("(the API key is not verified until the first capture)")}.`)
            : warn("Could not reach Sarvam. Check the address and your network."));
        } else {
          console.log(grey("  Loading available models…"));
          let speech: string[] = [];
          let verified = false;
          // Only the network call is guarded. Cancelling out of the menu below has
          // to stay a cancellation, not get reported as an unreachable provider.
          try {
            speech = (await listModels(baseUrl, draft.sttKey)).filter(m => SPEECH_MODEL.test(m)).slice(0, 12);
            verified = true;
          } catch {
            console.log(warn("Could not list models. Check the address and API key; you can still enter a model name."));
          }
          if (verified && speech.length === 0) console.log(warn("No transcription models in this account's listing. Enter one by name below."));
          let model = speech.length > 0
            ? await choose("Choose a transcription model", [
                ...speech.map(m => ({ value: m, label: m })),
                { value: "__manual__", label: "Enter a model name myself" },
              ], speech[0]!)
            : "";
          if (!model || model === "__manual__") {
            do { model = await ask("Model name", current?.stt.model ?? "whisper-large-v3"); } while (!model);
          }
          draft.stt = { provider: "openai-compatible", url: baseUrl, model };
          // Listing models proves the address and the key. Whether this particular
          // model accepts audio is only knowable by sending some, which setup does
          // not do: a transcription request costs money and needs a recording.
          console.log(verified
            ? ok(`Provider reachable and the API key works ${grey("(audio transcription not yet tested)")}.`)
            : warn("Could not verify the provider or the key. Setup can be saved, but transcription is not verified."));
        }
      } else {
        console.log(grey(sttChoice === "here"
          ? "  Start whisper-server on this machine, then enter its address below."
          : "  Point Tama at a whisper.cpp server you run elsewhere."));
        const url = await endpoint("Transcription server address", draft.stt?.url ?? current?.stt.url ?? "http://127.0.0.1:8081");
        draft.sttKey = current?.stt.url === url ? current.stt.apiKey : undefined;
        if (sttChoice === "remote" || draft.sttKey) {
          draft.sttKey = await secret(draft.sttKey ? "API key (Enter to keep saved key)" : "API key — optional") || draft.sttKey;
        }
        const local: SttAnswer = { provider: "whisper-cpp", url };
        draft.stt = local;
        const probe = () => new Stt({ ...local, apiKey: draft.sttKey }).health();
        let up = await probe();
        // Nothing answering on this machine is the normal first run, not a
        // mistake. Offer to do the three manual steps the README used to hand
        // over: get the binary, get a model, keep it running.
        if (!up && sttChoice === "here" && await yes("Nothing is listening there yet. Set up Whisper on this machine now?", true)) {
          up = await bootstrapWhisper(url, probe);
        }
        console.log(up
          ? ok(`Transcription server reachable ${grey("(audio transcription not yet tested)")}.`)
          : warn("Could not verify the transcription server. Start it or check the address/key before recording."));
      }
    };

    const askPage = async () => {
      // Same reason the voice page clears its key: "skip for now" on a second
      // visit has to mean Ask is off, not "keep what I said last time".
      draft.ask = undefined;
      draft.askKey = undefined;
      draft.askChoice = await choose("How would you like to ask questions about your notes?", [
        { value: "none", label: "Skip for now" },
        { value: "local", label: "Use a model running on your server" },
        { value: "cloud", label: "Use an API provider" },
      ], "none");
      if (draft.askChoice === "local") {
        draft.ask = { provider: "openai-compatible", baseUrl: await endpoint("Local model server address", "http://127.0.0.1:11434/v1"), model: "", maxChunks: 8 };
      } else if (draft.askChoice === "cloud") {
        const presets = [
          { value: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", keys: "https://openrouter.ai/settings/keys" },
          { value: "openai", label: "OpenAI", url: "https://api.openai.com/v1", keys: "https://platform.openai.com/api-keys" },
          { value: "groq", label: "Groq", url: "https://api.groq.com/openai/v1", keys: "https://console.groq.com/keys" },
          { value: "deepseek", label: "DeepSeek", url: "https://api.deepseek.com", keys: "https://platform.deepseek.com/api_keys" },
          { value: "together", label: "Together AI", url: "https://api.together.ai/v1", keys: "https://api.together.ai/settings/api-keys" },
        ];
        const provider = await choose("Choose your provider", [
          ...presets,
          { value: "custom", label: "Custom provider (OpenAI-compatible API)" },
        ], "openrouter");
        const preset = presets.find(p => p.value === provider);
        console.log(warn("Your questions and relevant note excerpts will be sent to this provider."));
        if (preset) console.log(`${grey("  Get your API key:")} ${preset.keys}`);
        draft.ask = {
          provider: "openai-compatible",
          baseUrl: preset?.url ?? await endpoint("Provider address", ""),
          model: "",
          maxChunks: 8,
        };
      }
      if (!draft.ask) return;
      const askConfig = draft.ask;
      draft.askKey = current?.ask?.baseUrl === askConfig.baseUrl ? current.ask.apiKey : undefined;
      if (draft.askChoice === "cloud" || await yes("Does this model server require an API key?", !!draft.askKey)) {
        draft.askKey = await secret(draft.askKey ? "API key (skip to keep saved key)" : "API key") || draft.askKey;
      }
      while (draft.askChoice === "cloud" && !draft.askKey) {
        console.log(warn("An API key is required for this setup. A public model list does not verify account access."));
        if (!(await yes("Enter an API key now?", true))) {
          // Ask is the optional half of Tama, so a missing key turns it off
          // rather than throwing away the vault and voice answers already
          // given. The old flow returned from the whole wizard here.
          console.log(grey("  Leaving Ask disabled. Capture, search and the editor plugin do not need it."));
          draft.ask = undefined;
          draft.askChoice = "none";
          return;
        }
        draft.askKey = await secret("API key");
      }
      console.log(grey("  Loading available models…"));
      let models: string[] = [];
      try {
        models = await listModels(askConfig.baseUrl, draft.askKey);
        console.log(`  ${bold(String(models.length))} models listed. ${grey("API-key validity and model access have not been verified yet.")}`);
      } catch { console.log(warn("Could not list models. Check the address, API key, and whether the server is running. You can still enter a model and test it below.")); }
      if (models.length > 0) {
        const filter = models.length > 12 ? await ask("Filter model names (for example llama or claude; Enter for all)", "") : "";
        const matches = models.filter(m => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 12);
        askConfig.model = await choose("Choose a model", [...matches.map(m => ({ value: m, label: m })), { value: "__manual__", label: "Enter a model name myself" }], matches[0] ?? "__manual__");
      }
      if (!askConfig.model || askConfig.model === "__manual__") {
        do { askConfig.model = await ask("Model name", current?.ask?.model ?? ""); } while (!askConfig.model);
      }
      if (await yes("Test this model with a short greeting? (cloud providers may charge)", true)) {
        try {
          const response = await fetch(`${askConfig.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(draft.askKey ? { authorization: `Bearer ${draft.askKey}` } : {}) }, body: JSON.stringify({ model: askConfig.model, messages: [{ role: "user", content: "Reply with hello." }], max_tokens: 16 }), signal: AbortSignal.timeout(60000) });
          const body = await response.json() as { choices?: { message?: { content?: string } }[] };
          if (!response.ok || !body.choices?.[0]?.message?.content) throw new Error();
          console.log(ok("Model replied successfully."));
        } catch { console.log(warn("Model test failed. Setup can be saved, but Ask is not verified.")); }
      }
    };

    const whatsappPage = async () => {
      draft.whatsapp = undefined;
      draft.bridge = undefined;
      draft.whatsappAccessToken = undefined;
      draft.whatsappAppSecret = undefined;
      draft.whatsappVerifyToken = undefined;
      const currentBridge = await readFile(bridgePath, "utf8")
        .then(text => JSON.parse(text) as BridgeSettings)
        .catch(() => undefined);

      let whatsappChoice = await choose("WhatsApp", [
        { value: "none", label: "Skip / disable WhatsApp" },
        { value: "bridge", label: "Link your own WhatsApp number (no Meta app; unofficial)" },
        { value: "cloud", label: "Connect a WhatsApp Cloud API number (official; needs a domain)" },
      ], current?.whatsapp ? "cloud" : currentBridge ? "bridge" : "none");

      if (whatsappChoice === "bridge") {
        // The Cloud API path asks for five values from a Meta dashboard. This one
        // asks for nothing you have to go and find, so the only thing worth
        // spending the user's attention on is the trade they are making.
        console.log(`  ${bold("Linking your own number")}`);
        console.log(grey("    Tama logs into WhatsApp Web as your account, the way the desktop app does."));
        console.log(grey("    No Meta app, no second number, no domain: the connection is outbound."));
        console.log(warn("  Unofficial. This is against WhatsApp's terms and the account can be banned."));
        console.log(grey("    A voice note becomes a note. Text from a number you allow is a question."));
        if (!(await yes("Set that up?", true))) {
          console.log(grey("  Skipping WhatsApp. Nothing else is affected."));
          whatsappChoice = "none";
        } else {
          let allowedFrom: string[] | null = null;
          do {
            const raw = await ask(
              "Numbers allowed to message it, comma-separated (Enter for only your own self-chat)",
              currentBridge?.allowedFrom.join(",") ?? "",
            );
            allowedFrom = raw.trim() ? whatsappSenders(raw) : [];
            if (!allowedFrom) console.log(warn("Use international numbers, digits only (a leading + is accepted)."));
          } while (!allowedFrom);
          // The token is minted after the config is saved, because minting needs
          // the data directory that the config settles.
          draft.bridge = bridgeSettings("", allowedFrom);
        }
      }
      if (whatsappChoice === "cloud") {
        // Meta's half cannot be automated away — it is a dashboard, a business
        // verification and a number registration. What the wizard can do is name
        // every value it is about to ask for and where that value is found,
        // rather than dropping the user at a prompt for a "phone number ID".
        console.log(`  ${bold("First, on Meta's side")} ${grey("— https://developers.facebook.com/apps")}`);
        console.log(grey("    1. Create a business app, then add the WhatsApp product to it."));
        console.log(grey("    2. Connect a WhatsApp Business Account and register a dedicated number."));
        console.log(warn("     That number's WhatsApp moves to the Cloud API. Do not use a number carrying personal chats."));
        console.log(grey("    3. WhatsApp → API Setup: copy the phone number ID (digits, not the visible number)."));
        console.log(grey("    4. Business settings → System users: create a token with whatsapp_business_messaging."));
        console.log(grey("    5. App settings → Basic: copy the app secret."));
        console.log(grey("  Tama generates the webhook verify token itself, and prints the callback URL to paste back."));
        if (!(await yes("Have those ready?", true))) {
          console.log(grey("  Skipping WhatsApp. Re-run setup when the Meta app is ready; nothing else is affected."));
          whatsappChoice = "none";
        }
      }
      if (whatsappChoice !== "cloud") return;
      let phoneNumberId = "";
      do {
        phoneNumberId = await ask("Meta phone number ID (not the visible phone number)", current?.whatsapp?.phoneNumberId ?? "");
        if (!/^\d+$/.test(phoneNumberId)) console.log(warn("The Meta phone number ID contains digits only."));
      } while (!/^\d+$/.test(phoneNumberId));

      let allowedFrom: string[] | null = null;
      do {
        const rawSenders = await ask(
          "Allowed sender numbers, comma-separated (country code + number)",
          current?.whatsapp?.allowedFrom.join(",") ?? "",
        );
        allowedFrom = whatsappSenders(rawSenders);
        if (!allowedFrom) console.log(warn("Enter at least one international number using digits only (a leading + is accepted)."));
      } while (!allowedFrom);

      const publicBaseUrl = await optionalPublicOrigin(current?.whatsapp?.publicBaseUrl);
      draft.whatsappAccessToken = await secret(
        current?.whatsapp?.accessToken
          ? "Meta access token (Enter to keep saved token)"
          : "Meta system-user access token",
      ) || current?.whatsapp?.accessToken;
      while (!draft.whatsappAccessToken) {
        console.log(warn("WhatsApp needs an access token with whatsapp_business_messaging permission."));
        draft.whatsappAccessToken = await secret("Meta system-user access token");
      }

      draft.whatsappAppSecret = await secret(
        current?.whatsapp?.appSecret
          ? "Meta app secret (Enter to keep saved secret)"
          : "Meta app secret (App Settings → Basic)",
      ) || current?.whatsapp?.appSecret;
      while (!draft.whatsappAppSecret) {
        console.log(warn("The Meta app secret is required to authenticate webhook POSTs."));
        draft.whatsappAppSecret = await secret("Meta app secret");
      }

      // Tama owns this shared secret, and prints it after saving so the admin
      // can paste the same value into Meta's webhook configuration.
      draft.whatsappVerifyToken = current?.whatsapp?.verifyToken ?? randomBytes(32).toString("hex");
      const graphApiVersion = current?.whatsapp?.graphApiVersion ?? "v23.0";
      draft.whatsapp = { phoneNumberId, allowedFrom, graphApiVersion, publicBaseUrl };

      try {
        const response = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
          headers: { authorization: `Bearer ${draft.whatsappAccessToken}` },
          signal: AbortSignal.timeout(8000),
        });
        console.log(response.ok
          ? ok("WhatsApp phone number and access token verified.")
          : warn(`Could not verify the WhatsApp token/number (HTTP ${response.status}). Setup can still be saved.`));
      } catch {
        console.log(warn("Could not reach Meta to verify the WhatsApp token/number. Setup can still be saved."));
      }
      if (walkAsk ? !draft.ask : !current?.ask) console.log(warn("Ask is disabled, so WhatsApp voice capture will work but text questions will not be answered yet."));
    };

    const reviewPage = async () => {
      // A block this run never asked about reads "unchanged", not "disabled": the
      // saved one is about to be carried through, and calling that a summary of
      // nothing is how a partial run looks like it wiped something.
      const sttSummary = draft.stt
        ? `${draft.stt.provider === "whisper-cpp" ? "whisper.cpp" : draft.stt.model} ${grey(`at ${draft.stt.url}`)}`
        : grey("unchanged");
      const whatsappSummary = !walkWhatsApp
        ? grey("unchanged")
        : draft.whatsapp
          ? `${draft.whatsapp.phoneNumberId} (${draft.whatsapp.allowedFrom.length} allowed)`
          : draft.bridge
            ? `your own number, unofficial bridge (${draft.bridge.allowedFrom.length} allowed + self-chat)`
            : "disabled";
      console.log(card([
        `${bold("World:")}     ${draft.worldName}`,
        `${bold("Vault:")}     ${short(draft.vaultPath)} ${grey(`(${draft.plan === "create" ? "new git vault" : "existing git vault"})`)}`,
        `${bold("Import:")}    ${draft.importSource ? `${draft.importNoteCount} Markdown notes from a read-only source` : "none"}`,
        `${bold("Voice:")}     ${sttSummary}`,
        `${bold("Ask:")}       ${walkAsk ? draft.askChoice : grey("unchanged")}`,
        `${bold("WhatsApp:")}  ${whatsappSummary}`,
        `${bold("Server:")}    http://127.0.0.1:${port}`,
        `${bold("Config:")}    ${short(configPath)}`,
      ], "About to write", frameWidth() - 2, 2));
      console.log();
      console.log(`  ${grey("Nothing has been written yet. Back re-opens any page above; the answer you gave is its default.")}`);
    };

    /** Writes everything the pages decided, or says why it did not. */
    const save = async (): Promise<void> => {
      // "Replace" is the truth for a full re-run and a lie for a scoped one: the
      // blocks this run skipped are being carried through, not overwritten.
      if (existsSync(configPath) && !(await yes(partial ? "Save these changes?" : "Replace the existing config?"))) {
        console.log(grey("  Setup cancelled; no changes were made."));
        return;
      }
      if (!(await yes(draft.importSource
        ? `Create this vault, save the configuration, and import ${draft.importNoteCount} notes?`
        : "Create this vault and save this configuration?"))) {
        console.log(grey("  Setup cancelled; no changes were made."));
        return;
      }
      const config = configFromAnswers({ vaultPath: draft.vaultPath, inbox: "Inbox", stt: draft.stt, port, ask: draft.ask, whatsapp: draft.whatsapp });
      if (draft.plan === "create") await Vault.initialize(draft.vaultPath);
      await mkdir(dirname(configPath), { recursive: true });
      const saved: any = { ...existing, ...config, server: { ...existing?.server, port, adminToken: current?.server.adminToken ?? (config.server as any).adminToken }, notify: existing?.notify ?? config.notify, safety: existing?.safety ?? config.safety, dataDir: existing?.dataDir ?? config.dataDir, vault: { path: draft.vaultPath, inbox: current?.vault.inbox ?? "Inbox" } };
      // Only a run that asked may remove. Deleting a block this run skipped would
      // turn "rename my world" into "and Ask is off now".
      if (walkAsk && !draft.ask) delete saved.ask;
      if (walkWhatsApp && !draft.whatsapp) delete saved.whatsapp;
      saved.world = { ...existing?.world, name: draft.worldName };
      for (const [section, key] of [["stt", draft.sttKey], ["ask", draft.askKey]] as const) {
        if (!key) continue;
        const keyPath = `${section}-${crypto.randomUUID()}.key`;
        await writeFile(resolve(dirname(configPath), keyPath), key, { mode: 0o600, flag: "wx" });
        saved[section].apiKeyFile = keyPath;
      }
      for (const [field, value] of [
        ["accessToken", draft.whatsappAccessToken],
        ["appSecret", draft.whatsappAppSecret],
        ["verifyToken", draft.whatsappVerifyToken],
      ] as const) {
        if (!value || !saved.whatsapp) continue;
        const keyPath = `whatsapp-${field}-${crypto.randomUUID()}.key`;
        await writeFile(resolve(dirname(configPath), keyPath), value, { mode: 0o600, flag: "wx" });
        saved.whatsapp[`${field}File`] = keyPath;
      }
      const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, configPath);

      if (draft.bridge) {
        // The bridge authenticates as a device, exactly like the iOS Shortcut, so
        // it gets a device token rather than the admin one. Minting it here is
        // what removes the curl-and-paste step the bridge used to need.
        const { mintToken } = await import("./auth.ts");
        const { openDb } = await import("./db.ts");
        const db = openDb(join(saved.dataDir, "tama.db"));
        try {
          draft.bridge = bridgeSettings(mintToken(db, "whatsapp-bridge").token, draft.bridge.allowedFrom);
        } finally {
          db.close();
        }
        await writeSettings(bridgePath, draft.bridge);
      }

      coverPage("Configuration saved", "Start Tama with bun run start, or tama-server if you built the binary.");
      console.log(card([
        `${bold("Vault:")}      ${short(saved.vault.path)} -> ${saved.vault.inbox}/`,
        `${bold("Server:")}     http://127.0.0.1:${port}`,
        `${bold("STT:")}        ${saved.stt ? saved.stt.provider : "none"}`,
        `${bold("Ask:")}        ${saved.ask ? (saved.ask.model ?? "enabled") : "disabled"}`,
        `${bold("WhatsApp:")}   ${saved.whatsapp ? "configured" : "disabled"}`,
      ], "Configuration", frameWidth() - 2, 2));
      console.log();
      if (draft.importSource) {
        console.log(grey("  Importing Markdown into the Tama vault…"));
        try {
          const importVault = new Vault(
            draft.vaultPath,
            saved.vault.inbox,
            saved.safety.dryRun,
            saved.safety.allowUnbackedVault,
          );
          const summary = await importMarkdownFolder(draft.importSource, draft.vaultPath, importVault);
          console.log(saved.safety.dryRun
            ? warn(`Dry run: ${summary.found} Markdown notes (${summary.bytes} bytes) considered; nothing was written.`)
            : ok(`${summary.imported} Markdown note${summary.imported === 1 ? "" : "s"} imported, ${summary.unchanged} unchanged.`));
          console.log(grey("  The source folder was read only. Its path was not saved in the configuration."));
        } catch (error) {
          console.log(warn(`Configuration was saved, but the note import stopped: ${error instanceof Error ? error.message : "unknown error"}`));
          console.log(grey(`  Retry it with: tama-server import ${JSON.stringify(draft.importSource)} --config ${JSON.stringify(configPath)}`));
        }
      }
      if (draft.ask?.apiKeyEnv) console.log(warn(`Before using Ask, set ${draft.ask.apiKeyEnv} in the environment that starts Tama.`));
      const admin = (saved.server as { adminToken: string }).adminToken;
      console.log(`  ${bold(partial ? "Pair another device" : "Pair your first device")}${grey(` — start the server, then open this on this machine:`)}`);
      console.log(`    ${bold(`http://localhost:${port}/pair?token=${admin}`)}`);
      console.log(grey("    A QR code a phone can scan. Keep that link to yourself; it mints pairing codes."));
      console.log(grey(`    Scripting it instead: curl -X POST localhost:${port}/pair/code -H "Authorization: Bearer ${admin}"`));
      if (draft.whatsapp && draft.whatsappVerifyToken) {
        console.log(`\n  ${bold("Finish WhatsApp in Meta")}`);
        console.log(`${grey("    callback URL: ")} ${draft.whatsapp.publicBaseUrl ? `${draft.whatsapp.publicBaseUrl}/webhooks/whatsapp` : "https://YOUR-PUBLIC-HOST/webhooks/whatsapp"}`);
        console.log(`${grey("    verify token: ")} ${draft.whatsappVerifyToken}`);
        console.log(grey("    Start Tama, then subscribe the WhatsApp Business Account to the messages webhook field."));
        // Saying "configuration saved" and stopping reads as done. It is not:
        // nothing arrives until Meta has the callback, and Meta will not accept a
        // callback it cannot reach over HTTPS.
        console.log(warn("  Until that is pasted in, WhatsApp stays silent — the config alone changes nothing."));
        if (!draft.whatsapp.publicBaseUrl) {
          console.log(warn("  You also need a public HTTPS address for this server. Meta will not call a plain-HTTP or private one."));
        }
      }
      if (draft.bridge) {
        console.log(`\n  ${bold("Link your WhatsApp")}${grey(" — one QR scan, then it is running:")}`);
        console.log(`    ${bold("docker compose --profile whatsapp-webjs up -d --build")}`);
        console.log(`    ${bold("docker compose --profile whatsapp-webjs logs -f whatsapp-webjs")} ${grey("scan the QR it prints")}`);
        console.log(grey(`    Settings and the device token are in ${bridgePath}. Change them later with tama-server settings.`));
        console.log(grey("    Send yourself a voice note to test. Text from an allowed number is a question."));
      }
      console.log();
    };

    // The welcome page. The preflight warnings live here rather than scrolling
    // past behind the first question: a missing ffmpeg is the reason voice will
    // fail later, and it has to be read before it is scrolled away.
    // Named from the flags rather than written out, because the sentence has to
    // stay true of whatever the caller scoped out. A scoped run that lists a
    // block it is about to walk anyway is the same lie the settings menu was
    // telling: it reads as "you will not be asked", and then it asks.
    const untouched = [
      ...(walkStt ? [] : ["Transcription"]),
      ...(walkAsk ? [] : ["Ask"]),
      ...(walkWhatsApp ? [] : ["WhatsApp"]),
    ];
    const untouchedList = untouched.length > 1
      ? `${untouched.slice(0, -1).join(", ")} and ${untouched[untouched.length - 1]}`
      : untouched.join("");
    coverPage(
      partial ? "Change your setup" : "Welcome to Tama",
      partial
        ? `${steps.length} pages: ${steps.map((s) => s.title).join(", ")}. ${untouchedList} ${untouched.length === 1 ? "is" : "are"} left as saved — each has its own section in settings.`
        : `${steps.length} pages. Nothing is written until the last one, and every page can be walked back to.`,
    );
    if (!Bun.which("ffmpeg")) console.log(warn(`ffmpeg is not installed; audio capture will fail until it is. ${grey(process.platform === "darwin" ? "brew install ffmpeg" : "apt install ffmpeg")}`));
    if (existing) console.log(grey("  Existing setup found. Unrelated settings and your admin token will be preserved."));
    console.log(card([
      `${bold("Pages:")}     ${steps.map((s) => s.title).join(" → ")}`,
      `${bold("Writes:")}    ${short(configPath)}`,
      `${bold("Keys:")}      ${grey("stored beside the config, 0600, never in the config itself")}`,
    ], "This run", frameWidth() - 2, 2));
    console.log();
    await navigate({ next: "Start" });

    const pages: Record<string, () => Promise<void>> = {
      world: worldPage,
      vault: vaultPage,
      voice: voicePage,
      ask: askPage,
      whatsapp: whatsappPage,
      review: reviewPage,
    };
    let index = 0;
    for (;;) {
      const step = steps[index]!;
      page(steps, index);
      await pages[step.key]!();
      const last = index === steps.length - 1;
      const move = await navigate({
        back: index > 0,
        next: last ? "Save" : "Next",
        status: `${index + 1}/${steps.length} · ${step.title}`,
      });
      if (move === "back") { index -= 1; continue; }
      if (!last) { index += 1; continue; }
      // Declining at the save prompt has already said so, so either way this
      // was the last page.
      await save();
      return;
    }
  } finally {
    input.setRawMode(false);
  }
}
