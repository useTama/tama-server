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

  return {
    vault: { path: expand(raw.vault.path), inbox: raw.vault.inbox ?? "Inbox" },
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
