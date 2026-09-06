import { test, expect } from "bun:test";
import { configFromAnswers, vaultPlan } from "../src/setup.ts";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("setup writes a local-only capture configuration by default", () => {
  const config = configFromAnswers({
    vaultPath: "/notes",
    inbox: "Inbox",
    sttUrl: "http://127.0.0.1:8081",
    port: 8080,
    ask: undefined,
  }) as { vault: { path: string }; stt: { provider: string; url: string }; ask?: unknown; server: { adminToken: string } };

  expect(config.vault.path).toBe("/notes");
  expect(config.stt).toEqual({ provider: "whisper-cpp", url: "http://127.0.0.1:8081" });
  expect(config.ask).toBeUndefined();
  expect(config.server.adminToken).toHaveLength(48);
});

test("setup records an OpenRouter model without placing its secret in config", () => {
  const config = configFromAnswers({
    vaultPath: "/notes",
    inbox: "Inbox",
    sttUrl: "http://127.0.0.1:8081",
    port: 8080,
    ask: {
      provider: "openai-compatible",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/free",
      apiKeyEnv: "OPENROUTER_API_KEY",
      maxChunks: 8,
    },
  }) as { ask: { apiKey?: string; apiKeyEnv?: string; baseUrl: string } };

  expect(config.ask.baseUrl).toBe("https://openrouter.ai/api/v1");
  expect(config.ask.apiKeyEnv).toBe("OPENROUTER_API_KEY");
  expect(config.ask.apiKey).toBeUndefined();
});

test("setup reuses an existing git-backed vault but rejects another non-empty folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "tama-setup-"));
  try {
    await mkdir(join(root, ".git"));
    expect(await vaultPlan(root)).toBe("use-existing");
    const nonVault = join(root, "not-a-vault");
    await mkdir(nonVault);
    await Bun.write(join(nonVault, "note.md"), "hello");
    await expect(vaultPlan(nonVault)).rejects.toThrow(/not git-tracked/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
