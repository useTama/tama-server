import { test, expect } from "bun:test";
import { bridgeSettings, configFromAnswers, vaultPlan, whatsappSenders } from "../src/setup.ts";
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

test("setup records WhatsApp routing without embedding its three secrets", () => {
  const config = configFromAnswers({
    vaultPath: "/notes",
    inbox: "Inbox",
    stt: { provider: "whisper-cpp", url: "http://127.0.0.1:8081" },
    port: 8080,
    ask: undefined,
    whatsapp: {
      phoneNumberId: "123456789",
      allowedFrom: ["919876543210"],
      graphApiVersion: "v23.0",
      publicBaseUrl: "https://tama.example.com",
    },
  }) as { whatsapp: Record<string, unknown> };

  expect(config.whatsapp).toEqual({
    phoneNumberId: "123456789",
    allowedFrom: ["919876543210"],
    graphApiVersion: "v23.0",
    publicBaseUrl: "https://tama.example.com",
  });
  expect(config.whatsapp.accessToken).toBeUndefined();
  expect(config.whatsapp.appSecret).toBeUndefined();
  expect(config.whatsapp.verifyToken).toBeUndefined();
});

test("setup normalizes a comma-separated WhatsApp allowlist", () => {
  expect(whatsappSenders("+919876543210, 12025550123  +919876543210"))
    .toEqual(["919876543210", "12025550123"]);
  expect(whatsappSenders("not-a-number")).toBeNull();
  expect(whatsappSenders("  ")).toBeNull();
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

test("a container deployment's volume paths override the home-directory defaults", () => {
  // The wizard runs inside the container for `docker compose run --rm setup`,
  // where ~ does not outlive the container but the mounted volumes do.
  const before = process.env.TAMA_DATA_DIR;
  process.env.TAMA_DATA_DIR = "/data";
  try {
    const config = configFromAnswers({
      vaultPath: "/vault",
      inbox: "Inbox",
      stt: { provider: "sarvam", url: "https://api.sarvam.ai", model: "saaras:v3", language: "unknown" },
      port: 8080,
      ask: undefined,
    }) as { dataDir: string; vault: { path: string }; stt: { provider: string } };
    expect(config.dataDir).toBe("/data");
    expect(config.vault.path).toBe("/vault");
    expect(config.stt.provider).toBe("sarvam");
  } finally {
    if (before === undefined) delete process.env.TAMA_DATA_DIR;
    else process.env.TAMA_DATA_DIR = before;
  }
});

test("bridge settings keep an empty allowlist and default to answering self-chat text", () => {
  const settings = bridgeSettings("tok", [], "");
  expect(settings).toEqual({ token: "tok", allowedFrom: [], askPrefix: "?", selfChatText: "ask" });
});

test("bridge settings record the numbers and prefix chosen for a scratchpad self-chat", () => {
  const settings = bridgeSettings("tok", whatsappSenders("+919876543210, 918887776665")!, "//", "ignore");
  expect(settings).toEqual({
    token: "tok",
    allowedFrom: ["919876543210", "918887776665"],
    askPrefix: "//",
    selfChatText: "ignore",
  });
});

test("editing the owner's bridge settings keeps audiences and the chat list", () => {
  // bridgeSettings is what the bridge section writes, and it replaces the file.
  // Dropping these would silently disconnect every group and empty the menu
  // that reconnects them.
  const kept = bridgeSettings("tok", ["919999900000"], "?", "ask", {
    audiences: [{ name: "the-boys", token: "t2", match: ["120363@g.us"], mention: "when-mentioned" }],
    chats: [{ id: "120363@g.us", name: "the boys" }],
  });
  expect(kept.audiences).toEqual([
    { name: "the-boys", token: "t2", match: ["120363@g.us"], mention: "when-mentioned" },
  ]);
  expect(kept.chats).toEqual([{ id: "120363@g.us", name: "the boys" }]);

  // Absent rather than present-and-empty, so a config file stays readable.
  expect("audiences" in bridgeSettings("tok", [], "?")).toBe(false);
});
