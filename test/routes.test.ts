import { test, expect } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Vault } from "../src/vault.ts";
import { GrepRetriever } from "../src/retrieval.ts";
import { mintToken } from "../src/auth.ts";
import { createRoutes, type RouteDeps } from "../src/routes.ts";
import { whatsappSource } from "../src/whatsapp.ts";
import { CaptureError } from "../src/capture-error.ts";
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
async function serverFixture(
  overrides: Partial<Config> = {},
  depsOverrides: Partial<RouteDeps> = {},
) {
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
  // Every message list the model was handed, so a test can assert what context
  // a request actually carried rather than only what it wrote afterwards.
  const asked: Array<Array<{ role: string; content: string }>> = [];
  const llm: Llm = {
    name: "fake",
    async *stream(opts) {
      asked.push(opts.messages.map((m) => ({ role: m.role, content: m.content })));
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
    ...depsOverrides,
  };
  const routes = createRoutes(deps);

  return {
    routes,
    db,
    config,
    asked: () => asked,
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

const WA: NonNullable<Config["whatsapp"]> = {
  phoneNumberId: "111222333",
  allowedFrom: ["919876543210"],
  accessToken: "access-secret",
  appSecret: "app-secret",
  verifyToken: "verify-secret",
  graphApiVersion: "v23.0",
};

/** One inbound text message, signed the way Meta signs it. */
function waText(body: string, id: string): Request {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { phone_number_id: WA.phoneNumberId },
      messages: [{ from: "919876543210", id, timestamp: "1788700000", type: "text", text: { body } }],
    } }] }],
  });
  return new Request("http://tama.local/webhooks/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", WA.appSecret).update(raw).digest("hex")}` },
    body: raw,
  });
}

/**
 * The Cloud API path had no conversation memory at all.
 *
 * `/ask` has remembered turns since memory.ts landed, but only when the client
 * supplies a thread, and this transport never did: it called askOnce with the
 * question and nothing else, so every WhatsApp message was a cold start and a
 * follow-up like "and the other one?" had no other one. The bridge in
 * clients/ passed a thread, so the unofficial path remembered and the official
 * one did not.
 */
test("a WhatsApp question carries the previous exchange", async () => {
  const sent: string[] = [];
  const f = await serverFixture({ whatsapp: WA }, {
    whatsappFetch: (async (_input: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).text.body);
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });
  try {
    expect((await f.routes.handle(waText("what did I say about the mic gain?", "wamid.1"))).status).toBe(200);
    await f.routes.whatsapp!.drain();
    expect((await f.routes.handle(waText("and the other one?", "wamid.2"))).status).toBe(200);
    await f.routes.whatsapp!.drain();

    expect(sent).toEqual(["the answer", "the answer"]);

    // Prior turns arrive as real messages ahead of the fenced excerpts, so the
    // second question is answered by something that knows what the first was.
    const second = f.asked()[1]!;
    expect(second.length).toBe(3);
    expect(second[0]!.content).toBe("what did I say about the mic gain?");
    expect(second[1]!.content).toBe("the answer");
    expect(second[2]!.content).toContain("and the other one?");
  } finally {
    await f.cleanup();
  }
});

test("the WhatsApp conversation thread is a pseudonym, not a phone number", async () => {
  const f = await serverFixture({ whatsapp: WA }, {
    whatsappFetch: (async (_input: string | URL | Request) =>
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
  });
  try {
    await f.routes.handle(waText("what did I say about the mic gain?", "wamid.1"));
    await f.routes.whatsapp!.drain();

    const rows = f.db.query("SELECT thread, role, text FROM conversation_turns ORDER BY id")
      .all() as Array<{ thread: string; role: string; text: string }>;
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);

    // drain() blanks the sender off the inbox row once a reply is sent, so a
    // raw number in conversation_turns - a table nothing ever wipes - would
    // quietly undo that. The thread is the same keyed pseudonym capture
    // attributes a note to.
    expect(rows.every((r) => r.thread === whatsappSource("919876543210", WA.appSecret))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("919876543210");
  } finally {
    await f.cleanup();
  }
});

// ---- #67: a capture failure says which part failed ----------------------

/**
 * A valid 16 kHz mono s16 WAV, so ffmpeg accepts the upload and the request
 * reaches the transcription stage. Posting arbitrary bytes would fail at
 * ffmpeg with a 415 and never exercise the stage under test.
 */
function wav(samples = 1600): Uint8Array {
  const data = samples * 2;
  const buf = new ArrayBuffer(44 + data);
  const view = new DataView(buf);
  const tag = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF"); view.setUint32(4, 36 + data, true); tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, data, true);
  // A quiet tone rather than silence, so nothing downstream treats the body as
  // empty for a reason unrelated to what is being tested.
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i / 8) * 4000, true);
  return new Uint8Array(buf);
}

const postAudio = (f: Awaited<ReturnType<typeof serverFixture>>) =>
  f.routes.handle(new Request("http://tama.local/capture", {
    method: "POST",
    headers: { authorization: `Bearer ${f.ownerToken}`, "content-type": "audio/wav" },
    body: new Blob([wav() as unknown as BlobPart], { type: "audio/wav" }),
  }));

test("an unreachable transcriber is 503 and names itself, not a bare 500", async () => {
  if (!Bun.which("ffmpeg")) return;
  // The failure behind #67: every stage collapsed into one 500, so whisper
  // being down was indistinguishable from a bug in the server and the reply
  // named neither.
  const stt = {
    async transcribe() {
      throw new CaptureError(503, "stt", "speech to text is unreachable at http://127.0.0.1:8081/inference",
        "is whisper-server running, and is stt.url pointing at it?");
    },
    async health() { return false; },
    endpoint: "http://127.0.0.1:8081/inference",
  } as unknown as Stt;

  const f = await serverFixture({}, { stt });
  try {
    const res = await postAudio(f);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; stage: string };
    expect(body.stage).toBe("stt");
    expect(body.error).toContain("unreachable");
    // The fix travels with the fault, because whoever hit this has no vendor
    // to ask and is usually the person who can fix it.
    expect(body.error).toContain("whisper-server");

    // And the stage is recorded, so the failures table answers the question
    // without anyone reading a stack trace.
    const row = f.db.query("SELECT kind, detail FROM failures ORDER BY at DESC LIMIT 1")
      .get() as { kind: string; detail: string };
    expect(row.kind).toBe("capture-failed");
    expect(row.detail).toStartWith("[stt]");
  } finally {
    await f.cleanup();
  }
});

test("an unclassified failure is still a 500, with no invented stage", async () => {
  if (!Bun.which("ffmpeg")) return;
  const stt = {
    async transcribe() { throw new Error("something nobody predicted"); },
    async health() { return true; },
    endpoint: "x",
  } as unknown as Stt;

  const f = await serverFixture({}, { stt });
  try {
    const res = await postAudio(f);
    expect(res.status).toBe(500);
    const body = await res.json() as { error: string; stage?: string };
    expect(body.error).toContain("something nobody predicted");
    expect(body.stage).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});
