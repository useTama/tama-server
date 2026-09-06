import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readdir, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "./vault.ts";
import { defaultConfigPath, loadConfig } from "./config.ts";
import { Stt } from "./stt.ts";
import { tama, red, grey, bold, ok, warn } from "./ui.ts";

type AskConfig =
  | undefined
  | { provider: "openai-compatible"; baseUrl: string; model: string; apiKeyEnv?: string; maxChunks: number };

export type SetupAnswers = {
  vaultPath: string;
  inbox: string;
  sttUrl: string;
  port: number;
  ask: AskConfig;
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
    stt: { provider: "whisper-cpp", url: a.sttUrl },
    server: { port: a.port, adminToken: randomBytes(24).toString("hex") },
    notify: { provider: "console", ntfy: { url: "https://ntfy.sh", topic: "" }, digestAt: "08:00" },
    safety: { allowUnbackedVault: false, dryRun: false },
    ...(a.ask ? { ask: a.ask } : {}),
    dataDir: "~/.local/share/tama",
  };
}

function homePath(suffix: string): string {
  return `${process.env.HOME ?? "~"}${suffix}`;
}

export function worldFolder(name: string): string {
  const folder = name.normalize("NFKC").replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, "-").replace(/^\.+|\.+$/g, "").trim();
  return folder.slice(0, 80) || "My World";
}

export async function runSetup(): Promise<void> {
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
  try {
    console.log(`\n${tama()} setup ${grey("— voice notes in a folder you own.")}\n`);
    const configPath = defaultConfigPath();
    const existing = existsSync(configPath) ? JSON.parse(await readFile(configPath, "utf8")) : undefined;
    const current = existing ? loadConfig(configPath) : undefined;
    if (existing) console.log(grey("Existing setup found. Unrelated settings and your admin token will be preserved."));
    const worldName = await ask("What would you like to name your world?", existing?.world?.name ?? "My World");
    let suggestedPath = current?.vault.path ?? homePath(`/Tama/${worldFolder(worldName)}`);
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
    // This is application state, not a choice most people need to make. Keep
    // it in the standard per-user location; deployments can still set
    // TAMA_CONFIG explicitly without going through the interactive wizard.
    const port = current?.server.port ?? 8080;
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("server port must be between 1 and 65535");

    const sttChoice = await choose("Speech-to-text", [
      { value: "local", label: "Use Whisper running on your server" },
      { value: "custom", label: "Use an API model (Whisper.cpp-compatible providers)" },
    ], "local");
    console.log(grey(sttChoice === "local" ? "Start Whisper on your server, then enter its address below." : "Connect a Whisper.cpp-compatible API here. Sarvam support is not available yet."));
    const sttUrl = await endpoint("Transcription server address", current?.stt.url ?? "http://127.0.0.1:8081");
    let sttKey = current?.stt.url === sttUrl ? current.stt.apiKey : undefined;
    if (sttChoice === "custom" || sttKey) {
      sttKey = await secret(sttKey ? "API key (Enter to keep saved key)" : "API key — optional") || sttKey;
    }
    console.log(await new Stt(sttUrl, sttKey).health()
      ? ok(`Transcription server reachable ${grey("(audio transcription not yet tested)")}.`)
      : warn("Could not verify the transcription server. Start it or check the address/key before recording."));
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
      try {
        const response = await fetch(`${askConfig.baseUrl}/models`, { headers: askKey ? { authorization: `Bearer ${askKey}` } : {}, signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as { data?: { id: string }[] };
        const models = body.data?.filter(m => typeof m.id === "string").map(m => m.id) ?? [];
        console.log(`${bold(String(models.length))} models listed. ${grey("API-key validity and model access have not been verified yet.")}`);
        const filter = models.length > 12 ? await ask("Filter model names (for example llama or claude; Enter for all)", "") : "";
        const matches = models.filter(m => m.toLowerCase().includes(filter.toLowerCase())).slice(0, 12);
        askConfig.model = await choose("Choose a model", [...matches.map(m => ({ value: m, label: m })), { value: "__manual__", label: "Enter a model name myself" }], matches[0] ?? "__manual__");
      } catch { console.log(warn("Could not list models. Check the address, API key, and whether the server is running. You can still enter a model and test it below.")); }
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

    const config = configFromAnswers({ vaultPath, inbox: "Inbox", sttUrl, port, ask: askConfig });
    console.log(`\n${bold("Summary")}\n${grey("  vault: ")} ${vaultPath} ${grey(`(${selectedVaultPlan === "create" ? "new git vault" : "existing git vault"})`)}\n${grey("  stt:   ")} ${sttChoice === "local" ? "local Whisper.cpp" : "custom compatible server"} ${grey(`at ${sttUrl}`)}\n${grey("  ask:   ")} ${askChoice}\n${grey("  config:")} ${configPath}`);
    if (existsSync(configPath) && !(await yes("Replace the existing config?"))) {
      console.log(grey("Setup cancelled; no changes were made."));
      return;
    }
    if (!(await yes("Create this vault and save this configuration?"))) {
      console.log(grey("Setup cancelled; no changes were made."));
      return;
    }
    if (selectedVaultPlan === "create") await Vault.initialize(vaultPath);
    await mkdir(dirname(configPath), { recursive: true });
    const saved: any = { ...existing, ...config, server: { ...existing?.server, port, adminToken: current?.server.adminToken ?? (config.server as any).adminToken }, notify: existing?.notify ?? config.notify, safety: existing?.safety ?? config.safety, dataDir: existing?.dataDir ?? config.dataDir, vault: { path: vaultPath, inbox: current?.vault.inbox ?? "Inbox" } };
    if (!askConfig) delete saved.ask;
    saved.world = { ...existing?.world, name: worldName };
    for (const [section, key] of [["stt", sttKey], ["ask", askKey]] as const) {
      if (!key) continue;
      const keyPath = `${section}-${crypto.randomUUID()}.key`;
      await writeFile(resolve(dirname(configPath), keyPath), key, { mode: 0o600, flag: "wx" });
      saved[section].apiKeyFile = keyPath;
    }
    const temporary = `${configPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, configPath);
    console.log(`\n${ok("Configuration saved.")} Start Tama with ${bold("bun run start")} (source checkout) or ${bold("tama-server")} (installed binary).`);
    if (askConfig?.apiKeyEnv) console.log(warn(`Before using Ask, set ${askConfig.apiKeyEnv} in the environment that starts Tama.`));
    console.log(grey("Start your chosen transcription server first, then pair a device at POST /pair/code."));
  } finally {
    input.setRawMode(false);
  }
}
