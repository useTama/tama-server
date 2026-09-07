import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Vault } from "../src/vault.ts";
import { GrepRetriever } from "../src/retrieval.ts";
import { mintToken } from "../src/auth.ts";
import { createRoutes, type RouteDeps } from "../src/routes.ts";
import type { Llm } from "../src/llm.ts";
import type { Stt } from "../src/stt.ts";
import type { Config } from "../src/config.ts";

const ADMIN = "a".repeat(48);

/**
 * A whole server, in a temp directory, with no port bound.
 *
 * This is what the extraction was for. Every assertion below is on wiring that
 * previously lived in a closure inside `Bun.serve`: the auth resolution, the
 * write refusal, the idempotency claim, the withheld sources.
 */
async function serverFixture(overrides: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), "tama-routes-"));
  await Vault.initialize(join(root, "vault"));
  await mkdir(join(root, "vault/Work"), { recursive: true });
  await writeFile(join(root, "vault/Work/cpa.md"), "the mic gain was clipping on the m4");
  await mkdir(join(root, "vault/Private"), { recursive: true });
  await writeFile(join(root, "vault/Private/money.md"), "the mic gain invoice was unpaid");

  const db = openDb(join(root, "data/tama.db"));
  const config = {
    vault: { path: join(root, "vault"), inbox: "Inbox" },
    dataDir: join(root, "data"),
    stt: { provider: "whisper-cpp" as const, url: "http://127.0.0.1:9" },
    server: { port: 0, adminToken: ADMIN },
    notify: { provider: "console" as const, ntfy: { url: "", topic: "" }, digestAt: "08:00" },
    safety: { allowUnbackedVault: false, dryRun: false },
    ask: { provider: "openai-compatible" as const, model: "fake", baseUrl: "http://x/v1", maxChunks: 8 },
    views: { work: { include: ["Work/**"] } },
    audiences: {
      guest: { view: "work", voice: "friend" as const, cite: false, length: "chat" as const, onNoMatch: "say-so" as const, mention: "always" as const, capture: false },
    },
    ...overrides,
  } as unknown as Config;

  let written = 0;
  const llm: Llm = {
    name: "fake",
    async *stream() {
      yield "the answer";
    },
  };
  const stt = { async transcribe() { return "spoken words"; }, async health() { return true; }, endpoint: "fake" } as unknown as Stt;

  const deps: RouteDeps = {
    config,
    db,
    vault: new Vault(config.vault.path, "Inbox", false, false),
    stt,
    retriever: new GrepRetriever(config.vault.path),
    llm,
    notifier: { name: "console", async send() {} },
    onWrite: () => { written++; },
  };
  const routes = createRoutes(deps);

  return {
    routes,
    db,
    config,
    writes: () => written,
    ownerToken: mintToken(db, "laptop").token,
    guestToken: mintToken(db, "group", "guest").token,
    cleanup: async () => { db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

const req = (path: string, init: RequestInit & { token?: string } = {}) => {
  const { token, ...rest } = init;
  return new Request(`http://tama.local${path}`, {
    ...rest,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.body ? { "content-type": "application/json" } : {}),
      ...(rest.headers ?? {}),
    },
  });
};

test("health needs no token and does not leak the vault path", async () => {
  const f = await serverFixture();
  try {
    const body = await (await f.routes.handle(req("/health"))).json() as any;
    expect(body.ok).toBe(true);
    expect(body.mcp.tools).toBe(5);
    // #10's fix, still holding: an unauthenticated route must not disclose
    // where someone's notes live.
    expect(JSON.stringify(body)).not.toContain("/vault");
  } finally {
    await f.cleanup();
  }
});

test("an unknown token is refused everywhere that matters", async () => {
  const f = await serverFixture();
  try {
    for (const path of ["/capture", "/ask", "/notes", "/sessions", "/mcp"]) {
      const res = await f.routes.handle(req(path, { method: "POST", token: "nope", body: "{}" }));
      expect(res.status).toBe(401);
    }
  } finally {
    await f.cleanup();
  }
});

test("a text capture is written, and schedules a commit", async () => {
  const f = await serverFixture();
  try {
    const res = await f.routes.handle(req("/capture", {
      method: "POST",
      token: f.ownerToken,
      body: JSON.stringify({ text: "a note from a test" }),
    }));
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.path).toContain("Inbox/");
    // The write path has to tell the caller to commit, or nothing ever does.
    expect(f.writes()).toBeGreaterThan(0);
  } finally {
    await f.cleanup();
  }
});

test("an idempotency key collapses a retry into one note", async () => {
  const f = await serverFixture();
  try {
    const send = () => f.routes.handle(req("/capture", {
      method: "POST",
      token: f.ownerToken,
      headers: { "idempotency-key": "same-key" },
      body: JSON.stringify({ text: "only once" }),
    }));
    const first = await (await send()).json() as any;
    const second = await (await send()).json() as any;
    // The same path, not two notes: a client retrying a timed-out request must
    // not double-write.
    expect(second.path).toBe(first.path);
  } finally {
    await f.cleanup();
  }
});

test("an audience may ask but not write", async () => {
  const f = await serverFixture();
  try {
    for (const [path, body] of [
      ["/notes", { path: "Work/x.md", text: "hi" }],
      ["/sessions", { project: "x", summary: "hi" }],
    ] as const) {
      const res = await f.routes.handle(req(path, { method: "POST", token: f.guestToken, body: JSON.stringify(body) }));
      expect(res.status).toBe(403);
    }
    const ask = await f.routes.handle(req("/ask", { method: "POST", token: f.guestToken, body: JSON.stringify({ question: "mic gain" }) }));
    expect(ask.status).toBe(200);
  } finally {
    await f.cleanup();
  }
});

test("an audience's view bounds what /ask can read, and its paths are withheld", async () => {
  const f = await serverFixture();
  try {
    const owner = await (await f.routes.handle(req("/ask", {
      method: "POST", token: f.ownerToken, body: JSON.stringify({ question: "mic gain" }),
    }))).json() as any;
    expect(owner.sources.map((s: any) => s.path).sort()).toEqual(["Private/money.md", "Work/cpa.md"]);

    const guest = await (await f.routes.handle(req("/ask", {
      method: "POST", token: f.guestToken, body: JSON.stringify({ question: "mic gain" }),
    }))).json() as any;
    // Withheld, not merely uncited: a path in the JSON is the same disclosure
    // as a path in the answer, and a chat client logs what it receives.
    expect(guest.sources).toEqual([]);
    expect(JSON.stringify(guest)).not.toContain("Private/money.md");
  } finally {
    await f.cleanup();
  }
});

test("a token naming an audience that no longer exists is refused, not promoted", async () => {
  const f = await serverFixture();
  try {
    const orphan = mintToken(f.db, "stale", "deleted-audience").token;
    const res = await f.routes.handle(req("/ask", { method: "POST", token: orphan, body: JSON.stringify({ question: "x" }) }));
    // Failing closed: a stale token must not inherit the owner's whole vault.
    expect(res.status).toBe(403);
  } finally {
    await f.cleanup();
  }
});

test("/notes appends and refuses to escape the vault", async () => {
  const f = await serverFixture();
  try {
    const ok = await (await f.routes.handle(req("/notes", {
      method: "POST", token: f.ownerToken,
      body: JSON.stringify({ path: "Projects/tama/log.md", text: "## entry\n" }),
    }))).json() as any;
    expect(ok.path).toBe("Projects/tama/log.md");

    const escape = await f.routes.handle(req("/notes", {
      method: "POST", token: f.ownerToken,
      body: JSON.stringify({ path: "../outside.md", text: "x" }),
    }));
    // The caller's mistake, so 400 rather than 500.
    expect(escape.status).toBe(400);
  } finally {
    await f.cleanup();
  }
});

test("/sessions slugs the project and appends to one file", async () => {
  const f = await serverFixture();
  try {
    const first = await (await f.routes.handle(req("/sessions", {
      method: "POST", token: f.ownerToken,
      body: JSON.stringify({ project: "Tama Server", summary: "did a thing" }),
    }))).json() as any;
    expect(first.relPath).toBe("Projects/tama-server/sessions.md");
    expect(first.created).toBe(true);

    const second = await (await f.routes.handle(req("/sessions", {
      method: "POST", token: f.ownerToken,
      body: JSON.stringify({ project: "tama-server", summary: "did another" }),
    }))).json() as any;
    expect(second.created).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("admin routes need the admin token, not a device token", async () => {
  const f = await serverFixture();
  try {
    const asDevice = await f.routes.handle(req("/tokens", { token: f.ownerToken }));
    expect(asDevice.status).toBe(403);

    const asAdmin = await f.routes.handle(req("/tokens", { token: ADMIN }));
    expect(asAdmin.status).toBe(200);
    const body = await asAdmin.json() as any;
    expect(body.tokens.length).toBeGreaterThan(0);
    // Hashes only, never the tokens themselves.
    expect(JSON.stringify(body)).not.toContain(f.ownerToken);
  } finally {
    await f.cleanup();
  }
});

test("pairing mints a working token, and a code is single-use", async () => {
  const f = await serverFixture();
  try {
    const { code } = await (await f.routes.handle(req("/pair/code", { method: "POST", token: ADMIN }))).json() as any;
    const paired = await (await f.routes.handle(req("/pair", {
      method: "POST", body: JSON.stringify({ code, deviceName: "phone" }),
    }))).json() as any;
    expect(paired.token).toBeTruthy();

    // It works.
    const health = await f.routes.handle(req("/ask", {
      method: "POST", token: paired.token, body: JSON.stringify({ question: "mic gain" }),
    }));
    expect(health.status).toBe(200);

    // And the code does not work twice.
    const again = await f.routes.handle(req("/pair", {
      method: "POST", body: JSON.stringify({ code, deviceName: "thief" }),
    }));
    expect(again.status).toBe(403);
  } finally {
    await f.cleanup();
  }
});

test("ask answers 501 with a useful body when no model is configured", async () => {
  const f = await serverFixture();
  try {
    const routes = createRoutes({
      config: f.config,
      db: f.db,
      vault: new Vault(f.config.vault.path, "Inbox", false, false),
      stt: { async transcribe() { return ""; }, async health() { return true; }, endpoint: "x" } as unknown as Stt,
      retriever: new GrepRetriever(f.config.vault.path),
      llm: null,
      notifier: { name: "console", async send() {} },
      onWrite: () => {},
    });
    const body = await (await routes.handle(req("/ask", {
      method: "POST", token: f.ownerToken, body: JSON.stringify({ question: "mic gain" }),
    }))).json() as any;
    // Retrieval works without a model, so say which half is missing rather
    // than pretending the route does not exist.
    expect(body.retrievalWorks).toBe(true);
    expect(body.wouldHaveUsed.length).toBeGreaterThan(0);
  } finally {
    await f.cleanup();
  }
});
