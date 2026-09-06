import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

let dir: string;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "tama-config-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function config(value: unknown): Promise<string> {
  const path = join(dir, "tama.config.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}

test("config explains how to recover from a missing config", () => {
  expect(() => loadConfig(join(dir, "missing.json"))).toThrow(/cp tama.config.example.json/);
});

test("config requires a vault path", async () => {
  const path = await config({ server: { adminToken: "secret" } });
  expect(() => loadConfig(path)).toThrow(/vault.path is required/);
});

test("config requires a real admin token", async () => {
  const missing = await config({ vault: { path: "/vault" }, server: {} });
  expect(() => loadConfig(missing)).toThrow(/adminToken is required/);
  const placeholder = await config({ vault: { path: "/vault" }, server: { adminToken: "openssl rand -hex 24" } });
  expect(() => loadConfig(placeholder)).toThrow(/adminToken is required/);
});

test("ntfy requires a topic", async () => {
  const path = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" }, notify: { provider: "ntfy" } });
  expect(() => loadConfig(path)).toThrow(/ntfy.topic is required/);
});

test("separate key files resolve relative to config for both providers", async () => {
  await writeFile(join(dir, "provider.key"), "fixture-key", { mode: 0o600 });
  const path = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" },
    stt: { apiKeyFile: "provider.key" },
    ask: { provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "fixture", apiKeyFile: "provider.key" } });
  expect(loadConfig(path).stt.apiKey).toBe("fixture-key");
  expect(loadConfig(path).ask?.apiKey).toBe("fixture-key");
});

test("ask can resolve a credential from the environment without storing it in config", async () => {
  process.env.TAMA_TEST_PROVIDER_KEY = "test-secret";
  try {
    const path = await config({
      vault: { path: "/vault" },
      server: { adminToken: "secret" },
      ask: {
        provider: "openai-compatible",
        baseUrl: "https://openrouter.ai/api/v1",
        model: "openrouter/free",
        apiKeyEnv: "TAMA_TEST_PROVIDER_KEY",
      },
    });
    expect(loadConfig(path).ask?.apiKey).toBe("test-secret");
  } finally {
    delete process.env.TAMA_TEST_PROVIDER_KEY;
  }
});
