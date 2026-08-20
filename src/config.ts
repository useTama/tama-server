import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export type Config = {
  vault: { path: string; inbox: string };
  stt: { url: string };
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
    baseUrl?: string;
    maxChunks: number;
  };
  dataDir: string;
};

export function loadConfig(path = "tama.config.json"): Config {
  if (!existsSync(path)) {
    throw new Error(`no config at ${path}\n  cp tama.config.example.json tama.config.json\n  then set vault.path and server.adminToken`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const home = process.env.HOME ?? "~";
  const expand = (p: string) => resolve(p.replace(/^~/, home));

  if (!raw?.vault?.path) throw new Error("config: vault.path is required");
  if (!raw?.server?.adminToken || String(raw.server.adminToken).includes("openssl")) {
    throw new Error("config: server.adminToken is required. generate one: openssl rand -hex 24");
  }

  const provider = raw.notify?.provider ?? "console";
  if (provider === "ntfy" && !raw.notify?.ntfy?.topic) {
    throw new Error("config: notify.ntfy.topic is required when provider is ntfy");
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
      apiKey: raw.ask.apiKey ?? process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY,
      baseUrl: raw.ask.baseUrl,
      maxChunks: Number(raw.ask.maxChunks ?? 8),
    };
  }

  return {
    vault: { path: expand(raw.vault.path), inbox: raw.vault.inbox ?? "Inbox" },
    ask,
    stt: { url: raw.stt?.url ?? "http://127.0.0.1:8081" },
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
