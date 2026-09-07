import { resolve, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { SARVAM_URL, type SttConfig } from "./stt.ts";

export type Config = {
  vault: { path: string; inbox: string };
  stt: SttConfig;
  server: { port: number; adminToken: string };
  notify: {
    provider: "console" | "ntfy";
    ntfy: { url: string; topic: string; token?: string };
    digestAt: string;
  };
  safety: { allowUnbackedVault: boolean; dryRun: boolean };
  /**
   * Optional by design. With no `ask` block the server runs exactly as it did
   * before this feature existed: capture works, /ask returns 501. That is the
   * free, accountless tier, and it must never require a key to keep working.
   */
  ask?: {
    provider: "anthropic" | "openai-compatible";
    model: string;
    apiKey?: string;
    /** Name of an environment variable containing the provider credential. */
    apiKeyEnv?: string;
    baseUrl?: string;
    maxChunks: number;
    /**
     * Output cap per answer. Optional: llm.ts owns the default, and the reason
     * it is configurable is that a gateway refuses a request whose max_tokens
     * exceeds the remaining balance, whatever the answer would have cost.
     */
    maxTokens?: number;
  };
  /**
   * Optional WhatsApp Cloud API transport. It is an adapter over capture and
   * ask, not a dependency of either path: deleting this block removes every
   * WhatsApp route and leaves the core HTTP API unchanged.
   */
  whatsapp?: {
    phoneNumberId: string;
    allowedFrom: string[];
    /** Public origin printed by setup; Meta calls the fixed webhook path on it. */
    publicBaseUrl?: string;
    accessToken: string;
    appSecret: string;
    verifyToken: string;
    graphApiVersion: string;
  };
  dataDir: string;
};

export function defaultConfigPath(): string {
  return process.env.TAMA_CONFIG ?? (existsSync("tama.config.json") ? resolve("tama.config.json") : resolve(process.env.HOME ?? ".", ".config/tama/tama.config.json"));
}

/** Shared by the server and the wizard, so `--config` means one thing in both. */
export function configPathFromArgs(args: string[]): string {
  const flag = args.indexOf("--config");
  if (flag === -1) return defaultConfigPath();
  const path = args[flag + 1];
  if (!path || path.startsWith("--")) throw new Error("--config requires a path");
  return resolve(path);
}

function askMaxTokens(value: unknown): number {
  const tokens = Number(value);
  if (!Number.isInteger(tokens) || tokens < 1) {
    throw new Error(`config: ask.maxTokens must be a positive whole number, got ${JSON.stringify(value)}`);
  }
  return tokens;
}

export function loadConfig(path = defaultConfigPath()): Config {
  if (!existsSync(path)) {
    throw new Error(`no config at ${path}\n  cp tama.config.example.json tama.config.json\n  then set vault.path and server.adminToken`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const home = process.env.HOME ?? "~";
  const expand = (p: string) => resolve(p.replace(/^~/, home));
  const credential = (section: any, name = "apiKey", fallback?: string): string | undefined => {
    const file = section?.[`${name}File`];
    const env = section?.[`${name}Env`];
    const value = file
      ? readFileSync(resolve(dirname(path), String(file)), "utf8")
      : env
        ? process.env[String(env)]
        : section?.[name] ?? (fallback ? process.env[fallback] : undefined);
    const clean = value === undefined || value === null ? "" : String(value).trim();
    return clean || undefined;
  };

  if (!raw?.vault?.path) throw new Error("config: vault.path is required");
  if (!raw?.server?.adminToken || String(raw.server.adminToken).includes("openssl")) {
    throw new Error("config: server.adminToken is required. generate one: openssl rand -hex 24");
  }

  const provider = raw.notify?.provider ?? "console";
  if (provider === "ntfy" && !raw.notify?.ntfy?.topic) {
    throw new Error("config: notify.ntfy.topic is required when provider is ntfy");
  }

  // stt.provider selects a wire format, so an unrecognized value has to fail
  // here and not as an opaque 404 on the first capture of the day.
  const sttProvider = raw.stt?.provider ?? "whisper-cpp";
  if (sttProvider !== "whisper-cpp" && sttProvider !== "openai-compatible" && sttProvider !== "sarvam") {
    throw new Error(`config: stt.provider must be "whisper-cpp", "openai-compatible" or "sarvam", got ${JSON.stringify(sttProvider)}`);
  }
  // Sarvam serves a default model and whisper.cpp serves whatever it was
  // started with; only the OpenAI shape genuinely cannot guess.
  if (sttProvider === "openai-compatible" && !raw.stt?.model) {
    throw new Error("config: stt.model is required for the openai-compatible provider (e.g. whisper-large-v3)");
  }
  if (sttProvider === "sarvam" && !credential(raw.stt)) {
    throw new Error("config: sarvam needs an API key. set stt.apiKey, stt.apiKeyEnv or stt.apiKeyFile");
  }

  // Absent `ask` is the normal case, not an error. Only validate once someone
  // has opted in, and then fail loudly rather than at the first question.
  let ask: Config["ask"];
  if (raw.ask) {
    const provider = raw.ask.provider;
    if (provider !== "anthropic" && provider !== "openai-compatible") {
      throw new Error(`config: ask.provider must be "anthropic" or "openai-compatible", got ${JSON.stringify(provider)}`);
    }
    if (!raw.ask.model) throw new Error("config: ask.model is required when ask is set");
    if (provider === "openai-compatible" && !raw.ask.baseUrl) {
      throw new Error("config: ask.baseUrl is required for the openai-compatible provider (e.g. http://127.0.0.1:11434/v1)");
    }
    // The key may legitimately live in the environment instead of the config
    // file, which is the better place for a secret, so its absence here is not
    // an error. A local llama.cpp or Ollama needs no key at all.
    ask = {
      provider,
      model: String(raw.ask.model),
      apiKey: credential(raw.ask, "apiKey", provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"),
      baseUrl: raw.ask.baseUrl,
      maxChunks: Number(raw.ask.maxChunks ?? 8),
      ...(raw.ask.maxTokens === undefined ? {} : { maxTokens: askMaxTokens(raw.ask.maxTokens) }),
    };
  }

  let whatsapp: Config["whatsapp"];
  if (raw.whatsapp) {
    const phoneNumberId = String(raw.whatsapp.phoneNumberId ?? "").trim();
    if (!/^\d+$/.test(phoneNumberId)) throw new Error("config: whatsapp.phoneNumberId is required and must contain digits only");

    if (!Array.isArray(raw.whatsapp.allowedFrom) || raw.whatsapp.allowedFrom.length === 0) {
      throw new Error("config: whatsapp.allowedFrom must list at least one sender in international format");
    }
    const allowedFrom: string[] = [...new Set<string>(
      (raw.whatsapp.allowedFrom as unknown[]).map((value) => String(value).trim().replace(/^\+/, "")),
    )];
    if (allowedFrom.some((value) => !/^\d{6,20}$/.test(value))) {
      throw new Error("config: whatsapp.allowedFrom entries must be international numbers containing digits only");
    }

    const accessToken = credential(raw.whatsapp, "accessToken");
    const appSecret = credential(raw.whatsapp, "appSecret");
    const verifyToken = credential(raw.whatsapp, "verifyToken");
    if (!accessToken) throw new Error("config: whatsapp access token is required (accessTokenEnv or accessTokenFile)");
    if (!appSecret) throw new Error("config: whatsapp app secret is required (appSecretEnv or appSecretFile)");
    if (!verifyToken) throw new Error("config: whatsapp verify token is required (verifyTokenEnv or verifyTokenFile)");

    const graphApiVersion = String(raw.whatsapp.graphApiVersion ?? "v23.0").trim();
    if (!/^v\d+\.\d+$/.test(graphApiVersion)) {
      throw new Error("config: whatsapp.graphApiVersion must look like v23.0");
    }
    let publicBaseUrl: string | undefined;
    if (raw.whatsapp.publicBaseUrl) {
      try {
        const url = new URL(String(raw.whatsapp.publicBaseUrl));
        if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
        publicBaseUrl = url.origin;
      } catch {
        throw new Error("config: whatsapp.publicBaseUrl must be a public https:// origin without credentials, query, or fragment");
      }
    }
    whatsapp = {
      phoneNumberId,
      allowedFrom,
      ...(publicBaseUrl ? { publicBaseUrl } : {}),
      accessToken,
      appSecret,
      verifyToken,
      graphApiVersion,
    };
  }

  return {
    vault: { path: expand(raw.vault.path), inbox: raw.vault.inbox ?? "Inbox" },
    ask,
    whatsapp,
    stt: {
      provider: sttProvider,
      // `baseUrl` is what the ask block calls the same thing, so accept either.
      url: raw.stt?.baseUrl ?? raw.stt?.url ?? (sttProvider === "sarvam" ? SARVAM_URL : "http://127.0.0.1:8081"),
      model: raw.stt?.model ? String(raw.stt.model) : undefined,
      language: raw.stt?.language ? String(raw.stt.language) : undefined,
      apiKey: credential(raw.stt),
    },
    server: { port: raw.server?.port ?? 8080, adminToken: String(raw.server.adminToken) },
    notify: {
      provider,
      ntfy: {
        url: raw.notify?.ntfy?.url ?? "https://ntfy.sh",
        topic: raw.notify?.ntfy?.topic ?? "",
        token: raw.notify?.ntfy?.token,
      },
      digestAt: raw.notify?.digestAt ?? "08:00",
    },
    safety: {
      allowUnbackedVault: raw.safety?.allowUnbackedVault ?? false,
      dryRun: raw.safety?.dryRun ?? false,
    },
    dataDir: expand(raw.dataDir ?? "./data"),
  };
}
