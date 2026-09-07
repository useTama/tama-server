import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { Vault } from "../src/vault.ts";
import { GrepRetriever } from "../src/retrieval.ts";
import { handleMcp, MCP_TOOL_NAMES, type McpCaller, type McpDeps } from "../src/mcp.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tama-mcp-"));
  await Vault.initialize(root);
  await mkdir(join(root, "Work"), { recursive: true });
  await mkdir(join(root, "KiksStudios/Clients"), { recursive: true });
  await writeFile(join(root, "Work/cpa.md"), "the mic gain problem was clipping on the m4");
  await writeFile(join(root, "KiksStudios/Clients/a.md"), "the mic gain problem for a client");
  const db = openDb(join(root, ".data", "t.db"));
  const deps: McpDeps = {
    retriever: new GrepRetriever(root),
    vault: new Vault(root, "Inbox", false, false),
    db,
    vaultRoot: root,
    maxChunks: 8,
    worldName: "2nd brain",
  };
  return { root, db, deps, cleanup: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

const owner: McpCaller = { deviceName: "laptop", mayWrite: true };
const guest: McpCaller = { deviceName: "group", audience: "315", view: { include: ["Work/**"] }, mayWrite: false };

function rpc(method: string, params?: unknown, id: unknown = 1) {
  return new Request("http://tama.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

const callText = async (res: Response) => {
  const body = await res.json() as any;
  return { text: body.result?.content?.[0]?.text as string, isError: Boolean(body.result?.isError), body };
};

test("initialize echoes the client's protocol version and names the server", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const res = await handleMcp(rpc("initialize", { protocolVersion: "2025-03-26" }), owner, deps);
    const body = await res.json() as any;
    // Echoed rather than asserted: for a tools-only server the revisions in
    // play have the same shape, and failing a handshake over a version string
    // would break clients for no behavioural reason.
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("2nd brain");
    expect(body.result.capabilities.tools).toBeDefined();
  } finally {
    await cleanup();
  }
});

test("a notification gets no response body, which is what the spec requires", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const res = await handleMcp(
      new Request("http://tama.local/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }),
      owner,
      deps,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  } finally {
    await cleanup();
  }
});

test("tools/list returns all five with schemas", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const body = await (await handleMcp(rpc("tools/list"), owner, deps)).json() as any;
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      // A description is the interface: a vague one is never called.
      expect(tool.description.length).toBeGreaterThan(80);
    }
  } finally {
    await cleanup();
  }
});

test("search_notes respects the caller's view", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const all = await callText(await handleMcp(rpc("tools/call", { name: "search_notes", arguments: { query: "mic gain problem" } }), owner, deps));
    expect(all.text).toContain("Work/cpa.md");
    expect(all.text).toContain("KiksStudios/Clients/a.md");

    const scoped = await callText(await handleMcp(rpc("tools/call", { name: "search_notes", arguments: { query: "mic gain problem" } }), guest, deps));
    expect(scoped.text).toContain("Work/cpa.md");
    expect(scoped.text).not.toContain("KiksStudios");
  } finally {
    await cleanup();
  }
});

test("an empty search says so instead of inviting invention", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const { text } = await callText(await handleMcp(rpc("tools/call", { name: "search_notes", arguments: { query: "zzzzz" } }), owner, deps));
    expect(text).toContain("Do not invent");
  } finally {
    await cleanup();
  }
});

test("read_note refuses to escape the vault, and hides what the view hides", async () => {
  const { deps, cleanup } = await fixture();
  try {
    for (const bad of ["../../etc/passwd.md", "/etc/passwd.md", "Work/../../out.md", ".git/config.md", "Work/cpa"]) {
      const { isError } = await callText(await handleMcp(rpc("tools/call", { name: "read_note", arguments: { path: bad } }), owner, deps));
      expect(isError).toBe(true);
    }
    // A note outside the view reads as absent, not as forbidden: "forbidden"
    // would confirm it exists, which is the same disclosure as its path.
    const hidden = await callText(await handleMcp(rpc("tools/call", { name: "read_note", arguments: { path: "KiksStudios/Clients/a.md" } }), guest, deps));
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toContain("No note at");

    const allowed = await callText(await handleMcp(rpc("tools/call", { name: "read_note", arguments: { path: "Work/cpa.md" } }), guest, deps));
    expect(allowed.text).toContain("clipping on the m4");
  } finally {
    await cleanup();
  }
});

test("an audience token may read but not write", async () => {
  const { deps, cleanup } = await fixture();
  try {
    for (const name of ["append_note", "record_session"]) {
      const args = name === "append_note" ? { path: "Work/x.md", text: "hi" } : { project: "x", summary: "hi" };
      const { text, isError } = await callText(await handleMcp(rpc("tools/call", { name, arguments: args }), guest, deps));
      expect(isError).toBe(true);
      expect(text).toContain("not write");
    }
  } finally {
    await cleanup();
  }
});

test("append_note and record_session go through the vault's own checks", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const appended = await callText(await handleMcp(rpc("tools/call", { name: "append_note", arguments: { path: "Projects/tama/notes.md", text: "## a note\n" } }), owner, deps));
    expect(appended.text).toContain("Created Projects/tama/notes.md");

    const escaped = await callText(await handleMcp(rpc("tools/call", { name: "append_note", arguments: { path: "../out.md", text: "x" } }), owner, deps));
    expect(escaped.isError).toBe(true);

    const session = await callText(await handleMcp(rpc("tools/call", { name: "record_session", arguments: { project: "Tama Server", summary: "fixed the mention detection", next: ["scoped tokens"] } }), owner, deps));
    expect(session.text).toContain("Projects/tama-server/sessions.md");
  } finally {
    await cleanup();
  }
});

test("a tool failure is a result, not a protocol error", async () => {
  const { deps, cleanup } = await fixture();
  try {
    // The model should see what went wrong and be able to try something else,
    // which a JSON-RPC error would hide from it entirely.
    const res = await handleMcp(rpc("tools/call", { name: "read_note", arguments: {} }), owner, deps);
    const body = await res.json() as any;
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBe(true);
  } finally {
    await cleanup();
  }
});

test("an unknown tool and a bad envelope are protocol errors", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const unknown = await (await handleMcp(rpc("tools/call", { name: "rm_rf" }), owner, deps)).json() as any;
    expect(unknown.error.code).toBe(-32601);

    const notRpc = await handleMcp(
      new Request("http://tama.local/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }),
      owner,
      deps,
    );
    expect(((await notRpc.json()) as any).error.code).toBe(-32600);

    const batched = await handleMcp(
      new Request("http://tama.local/mcp", { method: "POST", body: "[]", headers: { "content-type": "application/json" } }),
      owner,
      deps,
    );
    expect(((await batched.json()) as any).error.message).toContain("batched");
  } finally {
    await cleanup();
  }
});

test("GET is declined rather than left as an idle stream", async () => {
  const { deps, cleanup } = await fixture();
  try {
    const res = await handleMcp(new Request("http://tama.local/mcp"), owner, deps);
    expect(res.status).toBe(405);
  } finally {
    await cleanup();
  }
});
