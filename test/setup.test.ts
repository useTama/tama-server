import { test, expect } from "bun:test";
import { configFromAnswers, vaultPlan } from "../src/setup.ts";
import { SPEECH_MODEL } from "../src/stt.ts";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("setup writes a local-only capture configuration by default", () => {
  const config = configFromAnswers({
    vaultPath: "/notes",
    inbox: "Inbox",
    stt: { provider: "whisper-cpp", url: "http://127.0.0.1:8081" },
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
    stt: { provider: "whisper-cpp", url: "http://127.0.0.1:8081" },
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

test("a hosted transcription provider is recorded with its model and no secret", () => {
  const config = configFromAnswers({
    vaultPath: "/notes",
    inbox: "Inbox",
    stt: { provider: "openai-compatible", url: "https://api.groq.com/openai/v1", model: "whisper-large-v3" },
    port: 8080,
    ask: undefined,
  }) as { stt: { provider: string; url: string; model?: string; apiKey?: string } };

  expect(config.stt).toEqual({ provider: "openai-compatible", url: "https://api.groq.com/openai/v1", model: "whisper-large-v3" });
  expect(config.stt.apiKey).toBeUndefined();
});

test("only speech models are offered from a provider's model listing", () => {
  const listing = [
    "whisper-large-v3", "whisper-large-v3-turbo", "distil-whisper-large-v3-en",
    "whisper-1", "gpt-4o-transcribe", "voxtral-mini-latest",
    "llama-3.3-70b-versatile", "claude-sonnet-5", "text-embedding-3-small", "gpt-4o",
  ];
  expect(listing.filter(m => SPEECH_MODEL.test(m))).toEqual([
    "whisper-large-v3", "whisper-large-v3-turbo", "distil-whisper-large-v3-en",
    "whisper-1", "gpt-4o-transcribe", "voxtral-mini-latest",
  ]);
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
