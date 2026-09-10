import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, publicBaseUrl, resolveSpeaker, MAX_ASK_CHUNKS } from "../src/config.ts";
import { clientAddress } from "../src/connect-cli.ts";

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

test("stt defaults to whisper.cpp and rejects a provider it cannot speak to", async () => {
  const bare = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" } });
  expect(loadConfig(bare).stt).toEqual({ provider: "whisper-cpp", url: "http://127.0.0.1:8081", model: undefined, language: undefined, apiKey: undefined });

  const unknown = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" }, stt: { provider: "deepgram", url: "https://api.deepgram.com" } });
  expect(() => loadConfig(unknown)).toThrow(/stt.provider must be/);
});

test("sarvam defaults its own base url and carries a language hint", async () => {
  const keyless = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" },
    stt: { provider: "sarvam" } });
  expect(() => loadConfig(keyless)).toThrow(/sarvam needs an API key/);

  // No url and no model: both are Sarvam's to default, unlike the OpenAI shape.
  const path = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" },
    stt: { provider: "sarvam", apiKey: "sk-fixture", language: "hi-IN" } });
  expect(loadConfig(path).stt).toEqual({
    provider: "sarvam",
    url: "https://api.sarvam.ai",
    model: undefined,
    language: "hi-IN",
    apiKey: "sk-fixture",
  });
});

test("a hosted stt provider must name a model, and baseUrl reads the same as url", async () => {
  const modelless = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" },
    stt: { provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" } });
  expect(() => loadConfig(modelless)).toThrow(/stt.model is required/);

  const path = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" },
    stt: { provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3" } });
  expect(loadConfig(path).stt).toEqual({
    provider: "openai-compatible",
    url: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3",
    language: undefined,
    apiKey: undefined,
  });
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

test("WhatsApp stays absent by default and resolves all credentials outside config", async () => {
  const bare = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" } });
  expect(loadConfig(bare).whatsapp).toBeUndefined();

  process.env.TAMA_TEST_WA_ACCESS = "access-secret";
  process.env.TAMA_TEST_WA_APP = "app-secret";
  process.env.TAMA_TEST_WA_VERIFY = "verify-secret";
  try {
    const path = await config({
      vault: { path: "/vault" },
      server: { adminToken: "secret" },
      whatsapp: {
        phoneNumberId: "123456789",
        allowedFrom: ["+919876543210", "919876543210"],
        accessTokenEnv: "TAMA_TEST_WA_ACCESS",
        appSecretEnv: "TAMA_TEST_WA_APP",
        verifyTokenEnv: "TAMA_TEST_WA_VERIFY",
        publicBaseUrl: "https://tama.example.com/",
      },
    });
    expect(loadConfig(path).whatsapp).toEqual({
      phoneNumberId: "123456789",
      allowedFrom: ["919876543210"],
      accessToken: "access-secret",
      appSecret: "app-secret",
      verifyToken: "verify-secret",
      graphApiVersion: "v23.0",
      publicBaseUrl: "https://tama.example.com",
    });
  } finally {
    delete process.env.TAMA_TEST_WA_ACCESS;
    delete process.env.TAMA_TEST_WA_APP;
    delete process.env.TAMA_TEST_WA_VERIFY;
  }
});

test("WhatsApp rejects a non-HTTPS public webhook origin", async () => {
  const path = await config({
    vault: { path: "/vault" }, server: { adminToken: "secret" },
    whatsapp: {
      phoneNumberId: "123",
      allowedFrom: ["919876543210"],
      accessToken: "a", appSecret: "b", verifyToken: "c",
      publicBaseUrl: "http://localhost:8080/path",
    },
  });
  expect(() => loadConfig(path)).toThrow(/publicBaseUrl/);
});

test("a server with a domain and no WhatsApp can say where it is", async () => {
  // The failure this key moved to fix. `clientAddress` is fed the resolved
  // address, and while it was read out of the whatsapp block a box with a
  // domain and no Cloud API had nowhere to put one - so `connect` printed
  // http://127.0.0.1:8080 and the caveat about it being loopback, on a machine
  // where both are wrong, and the plugin installed cleanly and never connected.
  const path = await config({
    vault: { path: "/vault" },
    server: { adminToken: "secret", publicBaseUrl: "https://tama.example.com/" },
  });
  const loaded = loadConfig(path);
  expect(loaded.server.publicBaseUrl).toBe("https://tama.example.com");
  expect(publicBaseUrl(loaded)).toBe("https://tama.example.com");
  expect(clientAddress(publicBaseUrl(loaded), loaded.server.port)).toEqual({
    url: "https://tama.example.com",
    loopback: false,
  });
});

test("http is allowed at the server level, and still refused for Meta", async () => {
  // A tunnel and a LAN address are both plain http, and refusing them here
  // would only send people back to guessing. Meta will not call an http
  // callback, so httpsOnly reports nothing rather than something unusable.
  const path = await config({
    vault: { path: "/vault" },
    server: { adminToken: "secret", publicBaseUrl: "http://192.168.0.234:8080" },
  });
  const loaded = loadConfig(path);
  expect(publicBaseUrl(loaded)).toBe("http://192.168.0.234:8080");
  expect(publicBaseUrl(loaded, { httpsOnly: true })).toBeUndefined();
});

test("an address tama expose already wrote under whatsapp still resolves", async () => {
  // Every deployment where expose has run has it there. An upgrade that
  // stopped reading it would make a working box report itself unreachable.
  const path = await config({
    vault: { path: "/vault" }, server: { adminToken: "secret" },
    whatsapp: {
      phoneNumberId: "123", allowedFrom: ["919876543210"],
      accessToken: "a", appSecret: "b", verifyToken: "c",
      publicBaseUrl: "https://tama.tail1234.ts.net",
    },
  });
  expect(publicBaseUrl(loadConfig(path))).toBe("https://tama.tail1234.ts.net");
});

test("the server's own address wins over the one under whatsapp", async () => {
  const path = await config({
    vault: { path: "/vault" },
    server: { adminToken: "secret", publicBaseUrl: "https://new.example.com" },
    whatsapp: {
      phoneNumberId: "123", allowedFrom: ["919876543210"],
      accessToken: "a", appSecret: "b", verifyToken: "c",
      publicBaseUrl: "https://old.tail1234.ts.net",
    },
  });
  expect(publicBaseUrl(loadConfig(path))).toBe("https://new.example.com");
});

test("a base URL with a path is refused rather than normalised", async () => {
  // It would silently become https://host/tama/webhooks/... for one caller and
  // https://host/tama + /mcp for another.
  const path = await config({
    vault: { path: "/vault" },
    server: { adminToken: "secret", publicBaseUrl: "https://tama.example.com/sub" },
  });
  expect(() => loadConfig(path)).toThrow(/server\.publicBaseUrl/);
});

test("WhatsApp requires an explicit sender allowlist and webhook credentials", async () => {
  const noSenders = await config({
    vault: { path: "/vault" }, server: { adminToken: "secret" },
    whatsapp: { phoneNumberId: "123", accessToken: "a", appSecret: "b", verifyToken: "c" },
  });
  expect(() => loadConfig(noSenders)).toThrow(/allowedFrom/);

  const noSecret = await config({
    vault: { path: "/vault" }, server: { adminToken: "secret" },
    whatsapp: { phoneNumberId: "123", allowedFrom: ["919876543210"] },
  });
  expect(() => loadConfig(noSecret)).toThrow(/access token/);
});

test("a custom voice without a description is a startup failure", async () => {
  // The alternative is an audience whose voice section is the empty string,
  // which reads as no instruction at all rather than as a mistake.
  const dir = await mkdtemp(join(tmpdir(), "tama-audience-"));
  try {
    const path = join(dir, "tama.config.json");
    const base = {
      vault: { path: dir },
      stt: { provider: "whisper-cpp", url: "http://127.0.0.1:8081" },
      server: { adminToken: "a".repeat(48) },
    };
    await writeFile(path, JSON.stringify({ ...base, audiences: { boys: { view: "none", voice: "custom" } } }));
    expect(() => loadConfig(path)).toThrow(/voicePrompt/);

    await writeFile(path, JSON.stringify({
      ...base,
      audiences: { boys: { view: "none", voice: "custom", voicePrompt: "short and rude" } },
    }));
    expect(loadConfig(path).audiences?.boys?.voicePrompt).toBe("short and rude");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown view on an audience fails at boot, not at request time", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tama-audience-view-"));
  try {
    const path = join(dir, "tama.config.json");
    await writeFile(path, JSON.stringify({
      vault: { path: dir },
      stt: { provider: "whisper-cpp", url: "http://127.0.0.1:8081" },
      server: { adminToken: "a".repeat(48) },
      audiences: { work: { view: "wrok" } },
    }));
    // A view typo that resolved to everything at request time would widen what
    // a group can read, silently, which is the whole failure mode.
    expect(() => loadConfig(path)).toThrow(/unknown view/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- who is talking, in a group ----------------------------------------

/**
 * The bug: `people` is keyed by name, and a group message arrives labelled
 * with whatever the client could work out about the sender - a WhatsApp push
 * name, an address-book name, or, when neither exists, the bare phone number.
 * So the model got "Who is in this room: Priya, Anand" beside "A message from
 * 919876543210" and nothing joining them.
 */
const room = (people: unknown) => config({
  vault: { path: "/vault" },
  server: { adminToken: "secret" },
  audiences: { crew: { view: "none", people } },
});

test("a person's number resolves to the name the prompt uses for them", async () => {
  const c = loadConfig(await room({
    Priya: { about: "my cofounder, runs infra", numbers: ["+91 98765 43210"] },
  }));
  const ids = c.audiences!.crew!.identities;
  expect(resolveSpeaker("919876543210", ids)).toBe("Priya");
  // The one line about her is unchanged, so the prompt still reads the same.
  expect(c.audiences!.crew!.people).toEqual({ Priya: "my cofounder, runs infra" });
});

test("a push name resolves too, since it is what the client usually sends", async () => {
  // Push names carry emoji, surnames and nicknames, and a person can change
  // theirs whenever they like. Hoping one matches a config key is not a fix.
  const c = loadConfig(await room({
    Priya: { about: "cofounder", aka: ["Priya 🌸", "pri"] },
  }));
  const ids = c.audiences!.crew!.identities;
  expect(resolveSpeaker("Priya 🌸", ids)).toBe("Priya");
  expect(resolveSpeaker("PRI", ids)).toBe("Priya");
  expect(resolveSpeaker("Priya", ids)).toBe("Priya");
});

test("a country code on one side only still resolves", async () => {
  const c = loadConfig(await room({ Anand: { numbers: ["9876543210"] } }));
  const ids = c.audiences!.crew!.identities;
  expect(resolveSpeaker("919876543210", ids)).toBe("Anand");
  const other = loadConfig(await room({ Anand: { numbers: ["+919876543210"] } }));
  expect(resolveSpeaker("9876543210", other.audiences!.crew!.identities)).toBe("Anand");
});

test("someone with a number but nothing to say about them is still named", async () => {
  // Naming the sender is useful on its own; facts about them are separate.
  const c = loadConfig(await room({ Ravi: { numbers: ["919999911111"] } }));
  expect(c.audiences!.crew!.people).toBeUndefined();
  expect(resolveSpeaker("919999911111", c.audiences!.crew!.identities)).toBe("Ravi");
});

test("an unmapped sender passes through, because a number beats \"someone\"", async () => {
  const c = loadConfig(await room({ Priya: { numbers: ["919876543210"] } }));
  const ids = c.audiences!.crew!.identities;
  expect(resolveSpeaker("917777788888", ids)).toBe("917777788888");
  expect(resolveSpeaker("Unknown Person", ids)).toBe("Unknown Person");
  expect(resolveSpeaker(undefined, ids)).toBeUndefined();
});

test("a name with a digit in it is not looked up as a number", async () => {
  // Stripping non-digits from "Priya 2" would look her up as "2".
  const c = loadConfig(await room({ Two: { numbers: ["2"] }, "Priya 2": { about: "the other one" } }));
  expect(resolveSpeaker("Priya 2", c.audiences!.crew!.identities)).toBe("Priya 2");
});

test("plain-string people still work, so no existing config breaks", async () => {
  const c = loadConfig(await room({ Priya: "my cofounder", Anand: "candidate" }));
  expect(c.audiences!.crew!.people).toEqual({ Priya: "my cofounder", Anand: "candidate" });
  // The name is an identity in itself, so a client that resolved the sender
  // properly needs no mapping at all.
  expect(resolveSpeaker("anand", c.audiences!.crew!.identities)).toBe("Anand");
});

test("one identity claimed by two people fails at startup, not silently", async () => {
  // Otherwise one of them quietly receives the other's messages, and the owner
  // has no way to notice.
  const path = await room({
    Priya: { numbers: ["919876543210"] },
    Anand: { numbers: ["+91 98765 43210"] },
  });
  expect(() => loadConfig(path)).toThrow(/maps "919876543210" to both/);
});

const base = { vault: { path: "/vault" }, server: { adminToken: "secret" } };
const withAsk = {
  ...base,
  ask: { provider: "openai-compatible", model: "google/gemini-3.5-flash-lite", baseUrl: "https://example.test/v1" },
};

test("routing is off unless it is configured", async () => {
  // Absent route is the old behaviour exactly, and it has to stay that way:
  // turning it on means a model rewrites somebody's notes.
  expect(loadConfig(await config(withAsk)).route).toBeUndefined();
});

test("routing fills in defaults and can be turned off without deleting it", async () => {
  const on = loadConfig(await config({ ...withAsk, route: {} })).route;
  expect(on).toMatchObject({ enabled: true, everyMinutes: 15, nowNote: "now.md" });
  expect(loadConfig(await config({ ...withAsk, route: { enabled: false } })).route!.enabled).toBe(false);
});

test("routing without a model fails at load, not on the first cycle", async () => {
  // Otherwise it is a timer that quietly does nothing every fifteen minutes.
  const path = await config({ ...base, route: {} });
  expect(() => loadConfig(path)).toThrow(/route needs an ask block/);
  // Disabled needs no model: that is how someone turns it off after the key goes.
  expect(loadConfig(await config({ ...base, route: { enabled: false } })).route!.enabled).toBe(false);
});

test("now.md must be one file at the vault root", async () => {
  // It is rewritten whole every cycle, so a typo that names a folder, or a path
  // into a subtree, is worth refusing before anything is overwritten.
  for (const nowNote of ["Notes/now.md", "now", ".now.md"]) {
    const path = await config({ ...withAsk, route: { nowNote } });
    expect(() => loadConfig(path)).toThrow(/route.nowNote/);
  }
  expect(loadConfig(await config({ ...withAsk, route: { nowNote: "Now.md" } })).route!.nowNote).toBe("Now.md");
});

test("routing numbers are checked, because a bad one is a runaway cycle", async () => {
  const bad = async (route: unknown) => {
    const path = await config({ ...withAsk, route });
    expect(() => loadConfig(path)).toThrow();
  };
  await bad({ everyMinutes: 0 });
  await bad({ everyMinutes: -5 });
  await bad({ maxPerSweep: "lots" });
  // A confidence floor above 1 would never file anything.
  await bad({ minConfidence: 1.5 });
});

test("a whatsapp block holding only publicBaseUrl is refused", async () => {
  // Pinned because a shell command depended on it going the other way.
  // `tama expose` wrote publicBaseUrl with setdefault('whatsapp', {}), which
  // on any install using the unofficial bridge - i.e. any install with no
  // Cloud API block - turned a config that loaded into one that throws, and
  // index.ts turns that into a restart loop. The command whose job is making
  // the server reachable made it refuse to boot.
  //
  // The strictness is correct: a half-configured Cloud API must fail loudly
  // rather than half-run. So this test exists to keep it strict, and
  // docker/tama's writer is what had to change.
  //
  // It changed twice. First to refuse writing when the block was absent, which
  // left `tama expose` printing an apology instead of doing its job. Then, once
  // the key moved to `server` where it belonged, to write there - the server
  // block always exists, because server.adminToken is required. This test is
  // still the reason the writer may not go back to inventing a whatsapp block.
  const path = await config({
    vault: { path: "/vault" },
    server: { adminToken: "secret" },
    whatsapp: { publicBaseUrl: "https://tama.tail1234.ts.net" },
  });
  expect(() => loadConfig(path)).toThrow(/phoneNumberId is required/);
});

test("ask.maxChunks is clamped, not obeyed and not refused", async () => {
  // The input side of #22. The line was `Number(raw.ask.maxChunks ?? 8)`, so
  // 500 was accepted without comment - roughly 200KB of retrieved input on
  // every question, at ~400 characters an excerpt. Its sibling ask.maxTokens
  // had a validator; this had nothing.
  const ask = (maxChunks: unknown) => config({
    vault: { path: "/vault" },
    server: { adminToken: "secret" },
    ask: { provider: "openai-compatible", baseUrl: "http://x/v1", model: "m", apiKey: "k", maxChunks },
  });

  expect(loadConfig(await ask(4)).ask?.maxChunks).toBe(4);
  expect(loadConfig(await ask(25)).ask?.maxChunks).toBe(25);
  // Clamped rather than thrown, because a config that loads today has to keep
  // loading: refusing it would turn a working install into one that will not
  // boot on the next restart, to prevent a bill rather than a wrong answer.
  expect(loadConfig(await ask(500)).ask?.maxChunks).toBe(MAX_ASK_CHUNKS);
  // And nonsense falls back rather than reaching the retriever as NaN.
  expect(loadConfig(await ask("banana")).ask?.maxChunks).toBe(8);
  expect(loadConfig(await ask(0)).ask?.maxChunks).toBe(8);
  expect(loadConfig(await ask(-3)).ask?.maxChunks).toBe(8);
  // A fraction is floored rather than passed through to a slice length.
  expect(loadConfig(await ask(3.7)).ask?.maxChunks).toBe(3);
  // Absent stays the documented default.
  const bare = await config({ vault: { path: "/vault" }, server: { adminToken: "secret" } });
  expect(loadConfig(bare).ask).toBeUndefined();
});

test("ask.pin takes two lists of paths and drops what is not one", async () => {
  const withPin = (pin: unknown) => config({
    vault: { path: "/vault" },
    server: { adminToken: "secret" },
    ask: { provider: "openai-compatible", baseUrl: "http://x/v1", model: "m", apiKey: "k", maxChunks: 8, pin },
  });

  expect(loadConfig(await withPin({ conventions: ["CLAUDE.md"], state: ["Now.md"] })).ask?.pin)
    .toEqual({ conventions: ["CLAUDE.md"], state: ["Now.md"] });

  // Absent is the behaviour that existed before pinning, so it stays undefined
  // rather than becoming an empty object nothing can tell apart from a real one.
  expect(loadConfig(await withPin(undefined)).ask?.pin).toBeUndefined();
  expect(loadConfig(await withPin({})).ask?.pin).toBeUndefined();

  // Warned and dropped, never thrown: a config that loads today has to keep
  // loading, and a malformed pin costs a worse answer rather than a lost note.
  expect(loadConfig(await withPin("CLAUDE.md")).ask?.pin).toBeUndefined();
  expect(loadConfig(await withPin(["CLAUDE.md"])).ask?.pin).toBeUndefined();
  expect(loadConfig(await withPin({ conventions: "CLAUDE.md" })).ask?.pin).toBeUndefined();
  expect(loadConfig(await withPin({ conventions: ["CLAUDE.md", 7, "", "  "] })).ask?.pin)
    .toEqual({ conventions: ["CLAUDE.md"] });
});

test("whether a pinned path is safe to read is the vault's call, not the config's", async () => {
  // Duplicating Vault's traversal rules here is how the two drift until one is
  // wrong. loadPinnedNotes catches the throw and reports it instead.
  const path = await config({
    vault: { path: "/vault" },
    server: { adminToken: "secret" },
    ask: {
      provider: "openai-compatible", baseUrl: "http://x/v1", model: "m", apiKey: "k", maxChunks: 8,
      pin: { conventions: ["../escape.md"] },
    },
  });
  expect(loadConfig(path).ask?.pin).toEqual({ conventions: ["../escape.md"] });
});
