/**
 * The MCP surface: the vault as tools, for Claude Code and anything else that
 * speaks Model Context Protocol.
 *
 * Everything here is a wrapper. `search_notes` is `GrepRetriever.search`,
 * `append_note` is `Vault.appendMarkdown`, `record_session` is
 * `appendSession`. That is deliberate and it is why this file is short: the
 * capabilities were built and tested as HTTP routes first, so MCP is a second
 * doorway onto the same rooms rather than a second implementation of them.
 *
 * ## Why a route on the running server, and not stdio
 *
 * An MCP client normally *launches* a stdio server as a subprocess. Doing that
 * here would start a second tama against the same SQLite file and the same
 * vault: two preflights, two digest schedulers, two writers. tama is already a
 * daemon, so the protocol gets a route instead. For a stdio-only client,
 * `mcp-proxy` bridges to this without a second instance.
 *
 * SSE is not implemented because it is deprecated in the spec. Streamable HTTP
 * permits a plain JSON response when a tool does not stream, and none of these
 * five do.
 *
 * ## Why hand-rolled JSON-RPC
 *
 * A tools-only server needs three methods. The official SDK is more correct
 * against a moving spec and pulls a dependency tree into a project that has
 * almost none, matching how `llm.ts` talks to providers over plain fetch. If
 * this grows resources, prompts or sampling, that trade flips.
 */

import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import type { Retriever } from "./retrieval.ts";
import type { Vault } from "./vault.ts";
import { visible, type View } from "./views.ts";
import { appendSession } from "./session.ts";

/** Everything a tool needs, passed in so this file owns no state. */
export type McpDeps = {
  /** Called after a write, so an MCP append is committed like any other. */
  onWrite?: () => void;
  retriever: Retriever;
  vault: Vault;
  db: Database;
  vaultRoot: string;
  maxChunks: number;
  worldName?: string;
};

/**
 * Who is calling, resolved from the bearer token by the caller.
 *
 * `view` and `mayWrite` come from the token's audience, so a scoped MCP token
 * gives an agent a slice of the vault: mint one with `view: work` and the agent
 * in a client repo cannot search your job applications.
 */
export type McpCaller = { deviceName: string; audience?: string; view?: View; mayWrite: boolean };

const MAX_NOTE_BYTES = 256 * 1024;

type ToolResult = { text: string; isError?: boolean };

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>, caller: McpCaller, deps: McpDeps) => Promise<ToolResult>;
};

/**
 * A path the caller named, resolved and checked twice.
 *
 * Lexically, so `..` and absolute paths are rejected before touching the disk,
 * and against the view, so a note the caller may not see reads as absent rather
 * than as forbidden. "Forbidden" would confirm the note exists, which is the
 * same disclosure as showing its path.
 */
async function confinedNote(relPath: string, caller: McpCaller, deps: McpDeps): Promise<string> {
  const clean = relPath.replace(/^\/+/, "");
  const parts = clean.split("/");
  if (
    parts.length === 0 ||
    parts.some((p) => !p || p === "." || p === ".." || p.startsWith(".")) ||
    !clean.toLowerCase().endsWith(".md")
  ) {
    throw new Error(`no note at ${relPath}`);
  }
  if (!visible(clean, caller.view)) throw new Error(`no note at ${relPath}`);

  const root = await realpath(deps.vaultRoot);
  const abs = resolve(root, clean);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`no note at ${relPath}`);
  return abs;
}

const TOOLS: Tool[] = [
  {
    name: "search_notes",
    title: "Search the second brain",
    // Descriptions are the interface. A vague one is never called; an eager one
    // is called every turn and burns tokens. Both failures are silent, so these
    // say what the notes contain and when reaching for them is worth it.
    description:
      "Search the user's personal notes: their own decisions, project history, drafts, and work " +
      "logs, written by them over months. Use it before answering anything about what the user " +
      "previously decided, tried, or planned, and before starting work on one of their projects. " +
      "Scoring is keyword overlap, so query with words they would have written rather than a " +
      "question. Returns ranked excerpts with the note path. Not a web search and not documentation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words likely to appear in the notes." },
        limit: { type: "integer", description: "How many excerpts. Defaults to 8.", minimum: 1, maximum: 25 },
      },
      required: ["query"],
    },
    async run(args, caller, deps) {
      const query = String(args.query ?? "").trim();
      if (!query) return { text: "query is required", isError: true };
      const limit = Number.isInteger(args.limit) ? Math.min(25, Math.max(1, args.limit)) : deps.maxChunks;
      const chunks = await deps.retriever.search(query, limit, caller.view);
      if (chunks.length === 0) {
        return { text: `Nothing in the notes matches "${query}". Do not invent an answer from this.` };
      }
      return {
        text: chunks
          .map((c) => `## ${c.path}${c.capturedAt ? ` (captured ${c.capturedAt})` : ""}\n\n${c.text.trim()}`)
          .join("\n\n---\n\n"),
      };
    },
  },
  {
    name: "read_note",
    title: "Read one note",
    description:
      "Read a whole note by its vault-relative path, for when a search excerpt is not enough. " +
      "Paths come from search_notes. Markdown, as the user wrote it.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: 'For example "Projects/tama/plan.md".' } },
      required: ["path"],
    },
    async run(args, caller, deps) {
      const relPath = String(args.path ?? "").trim();
      if (!relPath) return { text: "path is required", isError: true };
      try {
        const abs = await confinedNote(relPath, caller, deps);
        const text = await readFile(abs, "utf8");
        return {
          text: text.length > MAX_NOTE_BYTES
            ? `${text.slice(0, MAX_NOTE_BYTES)}\n\n[truncated at ${MAX_NOTE_BYTES} bytes]`
            : text,
        };
      } catch {
        // One message for absent, hidden and malformed alike: distinguishing
        // them tells a caller which notes exist outside its view.
        return { text: `No note at ${relPath}.`, isError: true };
      }
    },
  },
  {
    name: "append_note",
    title: "Add to a note",
    description:
      "Append Markdown to a note, creating it if needed. Use it when the user says to remember " +
      "something, or when a decision was reached that they will want later. Appends, never " +
      "overwrites. Prefer record_session for a summary of work done.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'Vault-relative and ending in .md, e.g. "Projects/tama/notes.md".' },
        text: { type: "string", description: "Markdown to add. A heading helps it read as an entry." },
      },
      required: ["path", "text"],
    },
    async run(args, caller, deps) {
      if (!caller.mayWrite) return { text: "This token may read the notes but not write to them.", isError: true };
      const relPath = String(args.path ?? "").trim();
      const text = String(args.text ?? "");
      if (!relPath || !text.trim()) return { text: "path and text are both required", isError: true };
      try {
        const result = await deps.vault.appendMarkdown(relPath, text);
        deps.onWrite?.();
        return { text: `${result.created ? "Created" : "Appended to"} ${result.relPath} (${result.bytes} bytes).` };
      } catch (e) {
        return { text: e instanceof Error ? e.message : "could not write that note", isError: true };
      }
    },
  },
  {
    name: "record_session",
    title: "Record what this session did",
    description:
      "Write a summary of the work just done into the user's project log, so they can ask about " +
      "it weeks later. Call it when a session reaches something worth keeping: a decision, a fix " +
      "and its cause, a thing learned that was not obvious. One entry per session, appended to " +
      "the project's log. Say what was wrong and why, not what files changed.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project or repository name. Slugged, so casing does not matter." },
        summary: { type: "string", description: "A short paragraph: what happened and why it mattered." },
        shipped: { type: "array", items: { type: "string" }, description: "What actually landed." },
        learned: { type: "array", items: { type: "string" }, description: "Non-obvious things worth keeping." },
        next: { type: "array", items: { type: "string" }, description: "What the next session should pick up." },
      },
      required: ["project"],
    },
    async run(args, caller, deps) {
      if (!caller.mayWrite) return { text: "This token may read the notes but not write to them.", isError: true };
      const list = (v: unknown) => (Array.isArray(v) ? v.map((i) => String(i)) : undefined);
      try {
        const result = await appendSession(deps.vault, {
          project: String(args.project ?? ""),
          summary: String(args.summary ?? ""),
          shipped: list(args.shipped),
          learned: list(args.learned),
          next: list(args.next),
        });
        deps.onWrite?.();
        return { text: `${result.created ? "Started" : "Appended to"} ${result.relPath} (${result.bytes} bytes).` };
      } catch (e) {
        return { text: e instanceof Error ? e.message : "could not record the session", isError: true };
      }
    },
  },
  {
    name: "today",
    title: "What is active right now",
    description:
      "What the user has been doing lately: recent voice captures and the latest entry from each " +
      "project log. Use it at the start of a session to orient, or when they refer to something " +
      "recent without naming it.",
    inputSchema: { type: "object", properties: {} },
    async run(_args, caller, deps) {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
      const captures = deps.db
        .query("SELECT captured_at, note_path, words FROM captures WHERE captured_at >= ? ORDER BY captured_at DESC LIMIT 15")
        .all(since) as Array<{ captured_at: string; note_path: string; words: number }>;

      const lines: string[] = [];
      const visibleCaptures = captures.filter((c) => visible(c.note_path, caller.view));
      lines.push(`# Recent captures (last 7 days): ${visibleCaptures.length}`);
      for (const c of visibleCaptures) {
        lines.push(`- ${c.captured_at.slice(0, 16).replace("T", " ")} ${c.note_path} (${c.words} words)`);
      }

      // The tail of each project log, which is where session entries land.
      const logs = await deps.retriever.search("session project log", 25, caller.view).catch(() => []);
      const sessionLogs = logs.filter((c) => c.path.endsWith("/sessions.md"));
      if (sessionLogs.length > 0) {
        lines.push("", "# Project logs");
        for (const log of sessionLogs.slice(0, 8)) {
          const last = log.text.trim().split(/\n(?=## )/).at(-1) ?? "";
          lines.push("", `## ${log.path}`, "", last.slice(0, 600));
        }
      }
      if (visibleCaptures.length === 0 && sessionLogs.length === 0) {
        lines.push("", "Nothing recent. The notes may still have plenty; search them.");
      }
      return { text: lines.join("\n") };
    },
  },
];

/** JSON-RPC error codes, as the spec names them. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function rpcResult(id: unknown, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: unknown, code: number, message: string): Response {
  // 200 with a JSON-RPC error body: the transport succeeded, the call did not,
  // and a 4xx here makes clients report a connection problem instead.
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name);

export async function handleMcp(req: Request, caller: McpCaller, deps: McpDeps): Promise<Response> {
  if (req.method === "GET") {
    // A GET is a client opening a server-to-client stream. Nothing here pushes
    // notifications, so declining is correct and better than an idle stream.
    return new Response("this MCP server does not stream\n", { status: 405 });
  }
  if (req.method !== "POST") return new Response("method not allowed\n", { status: 405 });

  let body: any;
  try {
    body = await req.json();
  } catch {
    return rpcError(null, PARSE_ERROR, "invalid JSON");
  }
  if (Array.isArray(body)) {
    return rpcError(null, INVALID_REQUEST, "batched requests are not supported; send one call at a time");
  }
  if (!body || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpcError(body?.id, INVALID_REQUEST, "not a JSON-RPC 2.0 request");
  }

  const { id, method, params } = body as { id?: unknown; method: string; params?: any };
  // A notification has no id and takes no response. `notifications/initialized`
  // is the one every client sends, and answering it is a protocol error.
  const isNotification = id === undefined;

  switch (method) {
    case "initialize": {
      // The client's version is echoed when it sends one. For a tools-only
      // server every revision in play has the same shape here, and echoing
      // avoids failing a handshake over a version string that does not change
      // anything about these five calls.
      const version = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: deps.worldName?.trim() || "tama", version: "0.1.0" },
        instructions:
          "These tools reach one person's private Markdown notes. Search before answering " +
          "anything about what they previously decided or planned, and record a session when " +
          "work reaches something they will want later.",
      });
    }

    case "notifications/initialized":
    case "notifications/cancelled":
      return new Response(null, { status: 202 });

    case "ping":
      return isNotification ? new Response(null, { status: 202 }) : rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return rpcError(id, METHOD_NOT_FOUND, `no tool named ${JSON.stringify(params?.name ?? "")}`);
      try {
        const result = await tool.run(params?.arguments ?? {}, caller, deps);
        // A tool failure is a result with isError, not a protocol error: the
        // model should see what went wrong and can try something else, which a
        // JSON-RPC error would hide from it.
        return rpcResult(id, {
          content: [{ type: "text", text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error(`mcp ${tool.name} failed:`, detail);
        return rpcResult(id, { content: [{ type: "text", text: `That failed: ${detail}` }], isError: true });
      }
    }

    default:
      return isNotification
        ? new Response(null, { status: 202 })
        : rpcError(id, METHOD_NOT_FOUND, `unsupported method ${method}. this server implements tools only`);
  }
}
