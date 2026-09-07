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
import { tama, red, grey, bold, ok, warn } from "./ui.ts";
import { ask, choose, endpoint, optionalPublicOrigin, requireTty, secret, yes } from "./prompt.ts";

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
  /** Marks a question when self-chat text is otherwise ignored. */
  askPrefix: string;
  /**
   * What plain text in your own chat with yourself means. "ignore" keeps that
   * chat usable as a scratchpad; "ask" is the default because a bot that says
   * nothing when you talk to it reads as broken, whatever the reasoning.
   */
  selfChatText: "ask" | "ignore";
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
  askPrefix: string,
  selfChatText: "ask" | "ignore" = "ask",
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
    askPrefix: askPrefix.trim() || "?",
    selfChatText,
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
  stt: SttAnswer;
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
    stt: a.stt,
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

export async function runSetup(argv: string[] = Bun.argv): Promise<void> {
  requireTty("setup");
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
          output.write(`\r\x1b[2K  ${red("\u2588".repeat(Math.round(percent / 4)))}${grey("\u2591".repeat(25 - Math.round(percent / 4)))} ${percent}%`);
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
    console.log(`\n${tama()} setup ${grey("— voice notes in a folder you own.")}\n`);
    const configPath = configPathFromArgs(argv);
    // ffmpeg is not optional for audio, and finding that out at the first
    // recording instead of here costs a thought. git is what makes a vault a
    // vault, so its absence is fatal rather than a warning.
    if (!Bun.which("git")) throw new Error(`git is not installed. A Tama vault is a git repository.\n  ${process.platform === "darwin" ? "brew install git" : "apt install git"}`);
    if (!Bun.which("ffmpeg")) console.log(warn(`ffmpeg is not installed; audio capture will fail until it is. ${grey(process.platform === "darwin" ? "brew install ffmpeg" : "apt install ffmpeg")}`));
    const existing = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : undefined;
    const current = existing ? loadConfig(configPath) : undefined;
    if (existing) console.log(grey("Existing setup found. Unrelated settings and your admin token will be preserved."));
    const worldName = await ask("What would you like to name your world?", existing?.world?.name ?? "My World");
    let suggestedPath = current?.vault.path ?? process.env.TAMA_VAULT ?? homePath(`/Tama/${worldFolder(worldName)}`);
    console.log(`Your notes will be saved in ${bold(suggestedPath)}`);
    const customLocation = await yes("Choose a different location?");
    let vaultPath: string;
    let selectedVaultPlan: VaultPlan;
    let askLocation = customLocation;
    for (;;) {
      vaultPath = resolve((askLocation ? await ask("Folder for your world", suggestedPath) : suggestedPath).replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
      try { selectedVaultPlan = await vaultPlan(vaultPath); break; }
      catch { console.log(warn("Choose an empty folder or an existing git-backed vault. Your existing notes will not be changed.")); askLocation = true; }
    }

    const importChoice = await choose("Existing notes", [
      { value: "none", label: selectedVaultPlan === "create" ? "Start without importing notes" : "Keep this Tama vault as-is" },
      { value: "obsidian", label: "Import an Obsidian / Markdown second brain" },
    ], "none");
    let importSource: string | undefined;
    let importNoteCount = 0;
    if (importChoice === "obsidian") {
      console.log(grey("Choose a folder on this machine. Tama reads UTF-8 Markdown only, preserves note folders, and never modifies the source."));
      console.log(grey("Use a separate local Tama vault; attachments and hidden Obsidian settings are not copied."));
      for (;;) {
        const entered = await ask("Obsidian vault or Markdown folder", "");
        if (!entered) {
          console.log(warn("Enter the folder containing your Markdown notes."));
          continue;
        }
        const candidate = resolve(entered.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
        try {
          await assertSeparateImportRoots(candidate, vaultPath);
          const notes = await collectMarkdown(candidate);
          if (notes.length === 0) throw new Error("no Markdown notes found");
          importSource = candidate;
          importNoteCount = notes.length;
          console.log(ok(`Found ${notes.length} Markdown note${notes.length === 1 ? "" : "s"} to import.`));
          break;
        } catch (error) {
          console.log(warn(`Cannot use that folder: ${error instanceof Error ? error.message : "unknown error"}.`));
        }
      }
    }
    // This is application state, not a choice most people need to make. Keep
    // it in the standard per-user location; deployments can still set
    // TAMA_CONFIG explicitly without going through the interactive wizard.
    const port = current?.server.port ?? 8080;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("server port must be between 1 and 65535");

    // Three answers, two wire formats. "Here" and "elsewhere" differ only in
    // whether a key is likely, but they are separate lines because "where is
    // whisper running" is the question the user can actually answer.
    const sttChoice = await choose("Speech-to-text", [
      { value: "api", label: "A transcription API (Groq, OpenAI, Sarvam, …)" },
      { value: "here", label: "Whisper on this machine (private; needs CPU and a model download)" },
      { value: "remote", label: "Whisper on another machine" },
    ], current?.stt.provider === "whisper-cpp" ? "here" : "api");

    let stt: SttAnswer;
    let sttKey: string | undefined;
    if (sttChoice === "api") {
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
      if (preset) console.log(`${grey("Get your API key:")} ${preset.keys}`);
      const baseUrl = preset?.url ?? await endpoint("Provider address", "");
      sttKey = current?.stt.url === baseUrl ? current.stt.apiKey : undefined;
      sttKey = await secret(sttKey ? "API key (Enter to keep saved key)" : "API key") || sttKey;
      while (!sttKey) {
        console.log(warn("A hosted transcription provider needs an API key."));
        if (!(await yes("Enter an API key now?", true))) {
          console.log(grey("Setup cancelled; configuration was not changed."));
          return;
        }
        sttKey = await secret("API key");
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
        stt = { provider: "sarvam", url: baseUrl, model, language };
        // No unauthenticated listing route exists here, so this is reachability
        // only. A wrong key first shows up on the first capture, not now.
        console.log(await new Stt({ ...stt, apiKey: sttKey }).health()
          ? ok(`Sarvam reachable ${grey("(the API key is not verified until the first capture)")}.`)
          : warn("Could not reach Sarvam. Check the address and your network."));
      } else {
        console.log(grey("Loading available models…"));
        let speech: string[] = [];
        let verified = false;
        // Only the network call is guarded. Cancelling out of the menu below has
        // to stay a cancellation, not get reported as an unreachable provider.
        try {
          speech = (await listModels(baseUrl, sttKey)).filter(m => SPEECH_MODEL.test(m)).slice(0, 12);
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
        stt = { provider: "openai-compatible", url: baseUrl, model };
        // Listing models proves the address and the key. Whether this particular
        // model accepts audio is only knowable by sending some, which setup does
        // not do: a transcription request costs money and needs a recording.
        console.log(verified
          ? ok(`Provider reachable and the API key works ${grey("(audio transcription not yet tested)")}.`)
          : warn("Could not verify the provider or the key. Setup can be saved, but transcription is not verified."));
      }
    } else {
      console.log(grey(sttChoice === "here"
        ? "Start whisper-server on this machine, then enter its address below."
        : "Point Tama at a whisper.cpp server you run elsewhere."));
      const url = await endpoint("Transcription server address", current?.stt.url ?? "http://127.0.0.1:8081");
      sttKey = current?.stt.url === url ? current.stt.apiKey : undefined;
      if (sttChoice === "remote" || sttKey) {
        sttKey = await secret(sttKey ? "API key (Enter to keep saved key)" : "API key — optional") || sttKey;
      }
      stt = { provider: "whisper-cpp", url };
      const probe = () => new Stt({ ...stt, apiKey: sttKey }).health();
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
    const askChoice = await choose("How would you like to ask questions about your notes?", [
      { value: "none", label: "Skip for now" },
      { value: "local", label: "Use a model running on your server" },
      { value: "cloud", label: "Use an API provider" },
    ], "none");
    let askConfig: AskConfig;
    let askKey: string | undefined;
    if (askChoice === "local") {
      askConfig = { provider: "openai-compatible", baseUrl: await endpoint("Local model server address", "http://127.0.0.1:11434/v1"), model: "", maxChunks: 8 };
    } else if (askChoice === "cloud") {
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
      if (preset) console.log(`${grey("Get your API key:")} ${preset.keys}`);
      askConfig = {
        provider: "openai-compatible",
        baseUrl: preset?.url ?? await endpoint("Provider address", ""),
        model: "",
        maxChunks: 8,
      };
    }
    if (askConfig) {
      askKey = current?.ask?.baseUrl === askConfig.baseUrl ? current.ask.apiKey : undefined;
      if (askChoice === "cloud" || await yes("Does this model server require an API key?", !!askKey)) {
        askKey = await secret(askKey ? "API key (skip to keep saved key)" : "API key") || askKey;
      }
      while (askChoice === "cloud" && !askKey) {
        console.log(warn("An API key is required for this setup. A public model list does not verify account access."));
        if (!(await yes("Enter an API key now?", true))) {
          console.log(grey("Setup cancelled; configuration was not changed."));
          return;
        }
        askKey = await secret("API key");
      }
      console.log(grey("Loading available models…"));
      let models: string[] = [];
      try {
        models = await listModels(askConfig.baseUrl, askKey);
        console.log(`${bold(String(models.length))} models listed. ${grey("API-key validity and model access have not been verified yet.")}`);
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
          const response = await fetch(`${askConfig.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(askKey ? { authorization: `Bearer ${askKey}` } : {}) }, body: JSON.stringify({ model: askConfig.model, messages: [{ role: "user", content: "Reply with hello." }], max_tokens: 16 }), signal: AbortSignal.timeout(60000) });
          const body = await response.json() as { choices?: { message?: { content?: string } }[] };
          if (!response.ok || !body.choices?.[0]?.message?.content) throw new Error();
          console.log(ok("Model replied successfully."));
        } catch { console.log(warn("Model test failed. Setup can be saved, but Ask is not verified.")); }
      }
    }

    const bridgePath = resolve(dirname(configPath), "whatsapp-bridge.json");
    const currentBridge = await readFile(bridgePath, "utf8")
      .then(text => JSON.parse(text) as BridgeSettings)
      .catch(() => undefined);

    let whatsappChoice = await choose("WhatsApp", [
      { value: "none", label: "Skip / disable WhatsApp" },
      { value: "bridge", label: "Link your own WhatsApp number (no Meta app; unofficial)" },
      { value: "cloud", label: "Connect a WhatsApp Cloud API number (official; needs a domain)" },
    ], current?.whatsapp ? "cloud" : currentBridge ? "bridge" : "none");

    let bridge: BridgeSettings | undefined;
    if (whatsappChoice === "bridge") {
      // The Cloud API path asks for five values from a Meta dashboard. This one
      // asks for nothing you have to go and find, so the only thing worth
      // spending the user's attention on is the trade they are making.
      console.log(`\n${bold("Linking your own number")}`);
      console.log(grey("  Tama logs into WhatsApp Web as your account, the way the desktop app does."));
      console.log(grey("  No Meta app, no second number, no domain: the connection is outbound."));
      console.log(warn("  Unofficial. This is against WhatsApp's terms and the account can be banned."));
      console.log(grey("  A voice note becomes a note. Text from a number you allow is a question."));
      if (!(await yes("Set that up?", true))) {
        console.log(grey("Skipping WhatsApp. Nothing else is affected."));
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
        const selfChatText = await choose("Plain text in your own chat with yourself", [
          { value: "ask" as const, label: "Answer it — the chat is your assistant" },
          { value: "ignore" as const, label: "Ignore it — the chat stays a scratchpad, a prefix asks" },
        ], currentBridge?.selfChatText ?? "ask");
        const askPrefix = selfChatText === "ignore"
          ? await ask("Prefix that marks a question there", currentBridge?.askPrefix ?? "?")
          : currentBridge?.askPrefix ?? "?";
        // The token is minted after the config is saved, because minting needs
        // the data directory that the config settles.
        bridge = bridgeSettings("", allowedFrom, askPrefix, selfChatText);
      }
    }
    let whatsappConfig: WhatsAppAnswer | undefined;
    let whatsappAccessToken: string | undefined;
    let whatsappAppSecret: string | undefined;
    let whatsappVerifyToken: string | undefined;
    if (whatsappChoice === "cloud") {
      // Meta's half cannot be automated away — it is a dashboard, a business
      // verification and a number registration. What the wizard can do is name
      // every value it is about to ask for and where that value is found,
      // rather than dropping the user at a prompt for a "phone number ID".
      console.log(`\n${bold("First, on Meta's side")} ${grey("— https://developers.facebook.com/apps")}`);
      console.log(grey("  1. Create a business app, then add the WhatsApp product to it."));
      console.log(grey("  2. Connect a WhatsApp Business Account and register a dedicated number."));
      console.log(warn("     That number's WhatsApp moves to the Cloud API. Do not use a number carrying personal chats."));
      console.log(grey("  3. WhatsApp → API Setup: copy the phone number ID (digits, not the visible number)."));
      console.log(grey("  4. Business settings → System users: create a token with whatsapp_business_messaging."));
      console.log(grey("  5. App settings → Basic: copy the app secret."));
      console.log(grey("Tama generates the webhook verify token itself, and prints the callback URL to paste back."));
      if (!(await yes("Have those ready?", true))) {
        console.log(grey("Skipping WhatsApp. Re-run setup when the Meta app is ready; nothing else is affected."));
        whatsappChoice = "none";
      }
    }
    if (whatsappChoice === "cloud") {
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
      whatsappAccessToken = await secret(
        current?.whatsapp?.accessToken
          ? "Meta access token (Enter to keep saved token)"
          : "Meta system-user access token",
      ) || current?.whatsapp?.accessToken;
      while (!whatsappAccessToken) {
        console.log(warn("WhatsApp needs an access token with whatsapp_business_messaging permission."));
        whatsappAccessToken = await secret("Meta system-user access token");
      }

      whatsappAppSecret = await secret(
        current?.whatsapp?.appSecret
          ? "Meta app secret (Enter to keep saved secret)"
          : "Meta app secret (App Settings → Basic)",
      ) || current?.whatsapp?.appSecret;
      while (!whatsappAppSecret) {
        console.log(warn("The Meta app secret is required to authenticate webhook POSTs."));
        whatsappAppSecret = await secret("Meta app secret");
      }

      // Tama owns this shared secret, and prints it after saving so the admin
      // can paste the same value into Meta's webhook configuration.
      whatsappVerifyToken = current?.whatsapp?.verifyToken ?? randomBytes(32).toString("hex");
      const graphApiVersion = current?.whatsapp?.graphApiVersion ?? "v23.0";
      whatsappConfig = { phoneNumberId, allowedFrom, graphApiVersion, publicBaseUrl };

      try {
        const response = await fetch(`https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
          headers: { authorization: `Bearer ${whatsappAccessToken}` },
          signal: AbortSignal.timeout(8000),
        });
        console.log(response.ok
          ? ok("WhatsApp phone number and access token verified.")
          : warn(`Could not verify the WhatsApp token/number (HTTP ${response.status}). Setup can still be saved.`));
      } catch {
        console.log(warn("Could not reach Meta to verify the WhatsApp token/number. Setup can still be saved."));
      }
      if (!askConfig) console.log(warn("Ask is disabled, so WhatsApp voice capture will work but text questions will not be answered yet."));
    }

    const config = configFromAnswers({ vaultPath, inbox: "Inbox", stt, port, ask: askConfig, whatsapp: whatsappConfig });
    console.log(`\n${bold("Summary")}\n${grey("  vault: ")} ${vaultPath} ${grey(`(${selectedVaultPlan === "create" ? "new git vault" : "existing git vault"})`)}\n${grey("  import:")} ${importSource ? `${importNoteCount} Markdown notes from a read-only source` : "none"}\n${grey("  stt:   ")} ${stt.provider === "whisper-cpp" ? "whisper.cpp" : stt.model} ${grey(`at ${stt.url}`)}\n${grey("  ask:   ")} ${askChoice}\n${grey("  whatsapp:")} ${whatsappConfig ? `${whatsappConfig.phoneNumberId} (${whatsappConfig.allowedFrom.length} allowed)` : bridge ? `your own number, unofficial bridge (${bridge.allowedFrom.length} allowed + self-chat)` : "disabled"}\n${grey("  config:")} ${configPath}`);
    if (existsSync(configPath) && !(await yes("Replace the existing config?"))) {
      console.log(grey("Setup cancelled; no changes were made."));
      return;
    }
    if (!(await yes(importSource
      ? `Create this vault, save the configuration, and import ${importNoteCount} notes?`
      : "Create this vault and save this configuration?"))) {
      console.log(grey("Setup cancelled; no changes were made."));
      return;
    }
    if (selectedVaultPlan === "create") await Vault.initialize(vaultPath);
    await mkdir(dirname(configPath), { recursive: true });
    const saved: any = { ...existing, ...config, server: { ...existing?.server, port, adminToken: current?.server.adminToken ?? (config.server as any).adminToken }, notify: existing?.notify ?? config.notify, safety: existing?.safety ?? config.safety, dataDir: existing?.dataDir ?? config.dataDir, vault: { path: vaultPath, inbox: current?.vault.inbox ?? "Inbox" } };
    if (!askConfig) delete saved.ask;
    if (!whatsappConfig) delete saved.whatsapp;
    saved.world = { ...existing?.world, name: worldName };
    for (const [section, key] of [["stt", sttKey], ["ask", askKey]] as const) {
      if (!key) continue;
      const keyPath = `${section}-${crypto.randomUUID()}.key`;
      await writeFile(resolve(dirname(configPath), keyPath), key, { mode: 0o600, flag: "wx" });
      saved[section].apiKeyFile = keyPath;
    }
    for (const [field, value] of [
      ["accessToken", whatsappAccessToken],
      ["appSecret", whatsappAppSecret],
      ["verifyToken", whatsappVerifyToken],
    ] as const) {
      if (!value || !saved.whatsapp) continue;
      const keyPath = `whatsapp-${field}-${crypto.randomUUID()}.key`;
      await writeFile(resolve(dirname(configPath), keyPath), value, { mode: 0o600, flag: "wx" });
      saved.whatsapp[`${field}File`] = keyPath;
    }
    const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, configPath);

    if (bridge) {
      // The bridge authenticates as a device, exactly like the iOS Shortcut, so
      // it gets a device token rather than the admin one. Minting it here is
      // what removes the curl-and-paste step the bridge used to need.
      const { mintToken } = await import("./auth.ts");
      const { openDb } = await import("./db.ts");
      const db = openDb(join(saved.dataDir, "tama.db"));
      try {
        bridge = bridgeSettings(mintToken(db, "whatsapp-bridge").token, bridge.allowedFrom, bridge.askPrefix, bridge.selfChatText);
      } finally {
        db.close();
      }
      await writeSettings(bridgePath, bridge);
    }
    console.log(`\n${ok("Configuration saved.")} Start Tama with ${bold("bun run start")} (source checkout) or ${bold("tama-server")} (installed binary).`);
    if (importSource) {
      console.log(grey("Importing Markdown into the Tama vault…"));
      try {
        const importVault = new Vault(
          vaultPath,
          saved.vault.inbox,
          saved.safety.dryRun,
          saved.safety.allowUnbackedVault,
        );
        const summary = await importMarkdownFolder(importSource, vaultPath, importVault);
        console.log(saved.safety.dryRun
          ? warn(`Dry run: ${summary.found} Markdown notes (${summary.bytes} bytes) considered; nothing was written.`)
          : ok(`${summary.imported} Markdown note${summary.imported === 1 ? "" : "s"} imported, ${summary.unchanged} unchanged.`));
        console.log(grey("The source folder was read only. Its path was not saved in the configuration."));
      } catch (error) {
        console.log(warn(`Configuration was saved, but the note import stopped: ${error instanceof Error ? error.message : "unknown error"}`));
        console.log(grey(`Retry it with: tama-server import ${JSON.stringify(importSource)} --config ${JSON.stringify(configPath)}`));
      }
    }
    if (askConfig?.apiKeyEnv) console.log(warn(`Before using Ask, set ${askConfig.apiKeyEnv} in the environment that starts Tama.`));
    const admin = (saved.server as { adminToken: string }).adminToken;
    console.log(`\n${bold("Pair your first device")}${grey(` — start the server, then open this on this machine:`)}`);
    console.log(`  ${bold(`http://localhost:${port}/pair?token=${admin}`)}`);
    console.log(grey("  A QR code a phone can scan. Keep that link to yourself; it mints pairing codes."));
    console.log(grey(`  Scripting it instead: curl -X POST localhost:${port}/pair/code -H "Authorization: Bearer ${admin}"`));
    if (whatsappConfig && whatsappVerifyToken) {
      console.log(`\n${bold("Finish WhatsApp in Meta")}`);
      console.log(`${grey("  callback URL: ")} ${whatsappConfig.publicBaseUrl ? `${whatsappConfig.publicBaseUrl}/webhooks/whatsapp` : "https://YOUR-PUBLIC-HOST/webhooks/whatsapp"}`);
      console.log(`${grey("  verify token: ")} ${whatsappVerifyToken}`);
      console.log(grey("  Start Tama, then subscribe the WhatsApp Business Account to the messages webhook field."));
      // Saying "configuration saved" and stopping reads as done. It is not:
      // nothing arrives until Meta has the callback, and Meta will not accept a
      // callback it cannot reach over HTTPS.
      console.log(warn("  Until that is pasted in, WhatsApp stays silent — the config alone changes nothing."));
      if (!whatsappConfig.publicBaseUrl) {
        console.log(warn("  You also need a public HTTPS address for this server. Meta will not call a plain-HTTP or private one."));
      }
    }
    if (bridge) {
      console.log(`\n${bold("Link your WhatsApp")}${grey(" — one QR scan, then it is running:")}`);
      console.log(`  ${bold("docker compose --profile whatsapp-webjs up -d --build")}`);
      console.log(`  ${bold("docker compose --profile whatsapp-webjs logs -f whatsapp-webjs")} ${grey("scan the QR it prints")}`);
      console.log(grey(`  Settings and the device token are in ${bridgePath}. Change them later with tama-server settings.`));
      console.log(grey("  Send yourself a voice note to test. Text from an allowed number is a question."));
    }
  } finally {
    input.setRawMode(false);
  }
}
