import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readdir, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "./vault.ts";
import { assertSeparateImportRoots, collectMarkdown, importMarkdownFolder } from "./import.ts";
import { configPathFromArgs, loadConfig } from "./config.ts";
import { Stt, SPEECH_MODEL, SARVAM_URL, SARVAM_DEFAULT_MODEL, type SttConfig } from "./stt.ts";
import * as whisper from "./whisper.ts";
import { tama, red, grey, bold, ok, warn } from "./ui.ts";

type AskConfig =
  | undefined
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKeyEnv?: string; maxChunks: number };

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
async function listModels(baseUrl: string, apiKey?: string): Promise<string[]> {
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
  if (!input.isTTY || !output.isTTY) throw new Error("tama setup needs an interactive terminal");
  const ask = async (label: string, fallback: string) => {
    const rl = createInterface({ input, output });
    try { return (await rl.question(`${red("›")} ${label}${fallback ? grey(` [${fallback}]`) : ""}: `)).trim() || fallback; }
    finally { rl.close(); }
  };
  const secret = async (label: string): Promise<string> => {
    output.write(`${red("›")} ${label}${grey(" (hidden; Enter to skip)")}: `);
    return new Promise((done, fail) => {
      let value = "";
      const wasRaw = input.isRaw;
      const finish = (cancelled = false) => {
        input.off("data", onData); input.setRawMode(wasRaw); input.pause(); output.write("\n");
        if (cancelled) fail(new Error("Setup cancelled")); else done(value.trim());
      };
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString()) {
          if (char === "\u0003") return finish(true);
          if (char === "\r" || char === "\n") return finish();
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " ") value += char;
        }
      };
      input.setRawMode(true); input.on("data", onData); input.resume();
    });
  };
  const endpoint = async (label: string, fallback: string): Promise<string> => {
    for (;;) {
      const value = await ask(label, fallback);
      try {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        return value.replace(/\/+$/, "");
      } catch { console.log(warn("Enter an http:// or https:// server address without credentials or query parameters.")); }
    }
  };
  const optionalPublicOrigin = async (fallback?: string): Promise<string | undefined> => {
    for (;;) {
      const value = await ask("Public HTTPS base URL (Enter to configure later)", fallback ?? "");
      if (!value) return undefined;
      try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        return url.origin;
      } catch { console.log(warn("Enter an https:// origin such as https://tama.example.com, with no path or credentials.")); }
    }
  };
  const choose = async <T extends string>(label: string, options: Array<{ value: T; label: string }>, fallback: T): Promise<T> => {
    let selected = options.findIndex((o) => o.value === fallback);
    console.log(`\n${bold(label)}  ${grey("(↑/↓ or j/k, then Enter)")}`);
    let drawn = false;
    const draw = () => {
      if (drawn) output.write(`\x1b[${options.length}A`);
      for (let i = 0; i < options.length; i++) {
        const option = options[i]!;
        const chosen = i === selected;
        output.write(`\r\x1b[2K${chosen ? red("❯") : " "} ${grey(`${i + 1}.`)} ${chosen ? bold(option.label) : option.label}\n`);
      }
      drawn = true;
    };
    draw();
    return await new Promise<T>((done, fail) => {
      input.setRawMode(true);
      input.resume();
      const finish = (value?: T, error?: Error) => {
        input.setRawMode(false);
        input.off("data", onKey);
        input.pause();
        output.write("\n");
        if (error) fail(error);
        else done(value!);
      };
      const onKey = (chunk: Buffer) => {
        const key = chunk.toString();
        if (key === "\u0003") return finish(undefined, new Error("setup cancelled"));
        if (key === "\r" || key === "\n") return finish(options[selected]!.value);
        if (key === "\x1b[A" || key === "k") selected = (selected + options.length - 1) % options.length;
        else if (key === "\x1b[B" || key === "j") selected = (selected + 1) % options.length;
        else if (/^[1-9]$/.test(key) && Number(key) <= options.length) selected = Number(key) - 1;
        else return;
        draw();
      };
      input.on("data", onKey);
    });
  };
  const yes = async (label: string, fallback = false) => {
    const answer = (await ask(`${label} ${fallback ? "[Y/n]" : "[y/N]"}`, "")).toLowerCase();
    return answer ? answer === "y" || answer === "yes" : fallback;
  };
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

    const whatsappChoice = await choose("WhatsApp", [
      { value: "none", label: "Skip / disable WhatsApp" },
      { value: "cloud", label: "Connect a WhatsApp Cloud API number" },
    ], current?.whatsapp ? "cloud" : "none");
    let whatsappConfig: WhatsAppAnswer | undefined;
    let whatsappAccessToken: string | undefined;
    let whatsappAppSecret: string | undefined;
    let whatsappVerifyToken: string | undefined;
    if (whatsappChoice === "cloud") {
      console.log(grey("Use a dedicated number from Meta App Dashboard → WhatsApp → API Setup."));
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
    console.log(`\n${bold("Summary")}\n${grey("  vault: ")} ${vaultPath} ${grey(`(${selectedVaultPlan === "create" ? "new git vault" : "existing git vault"})`)}\n${grey("  import:")} ${importSource ? `${importNoteCount} Markdown notes from a read-only source` : "none"}\n${grey("  stt:   ")} ${stt.provider === "whisper-cpp" ? "whisper.cpp" : stt.model} ${grey(`at ${stt.url}`)}\n${grey("  ask:   ")} ${askChoice}\n${grey("  whatsapp:")} ${whatsappConfig ? `${whatsappConfig.phoneNumberId} (${whatsappConfig.allowedFrom.length} allowed)` : "disabled"}\n${grey("  config:")} ${configPath}`);
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
    }
  } finally {
    input.setRawMode(false);
  }
}
