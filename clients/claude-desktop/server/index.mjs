#!/usr/bin/env node
/**
 * A stdio MCP server that is only a pipe to a running tama.
 *
 * ## Why a proxy and not a server
 *
 * tama's MCP surface is a route on the daemon (`src/mcp.ts`), because a stdio
 * server would have the client launch a *second* tama against the same SQLite
 * file and the same vault. That decision is right and it leaves one gap:
 * Claude Desktop installs local stdio servers and nothing else. A remote
 * connector is dialled from Anthropic's servers, so it cannot reach a vault on
 * a tailnet or a laptop however correct its URL is.
 *
 * This closes the gap without reopening the decision. Claude Desktop gets a
 * local stdio server; the local stdio server owns no vault, no database and no
 * logic - it forwards JSON-RPC to the daemon that does.
 *
 * ## Why no SDK
 *
 * The stdio transport is newline-delimited JSON-RPC and tama's route answers
 * one object per POST. Forwarding lines needs no framing library, and the
 * server half was hand-rolled for the same reason (see `docs/mcp.md`).
 */

import { createInterface } from "node:readline";
import { relay } from "./relay.mjs";

const url = process.env.TAMA_URL?.trim();
const token = process.env.TAMA_TOKEN?.trim();

// stdout carries protocol and nothing else: one stray line breaks the client's
// parser, and the breakage looks like the extension being broken. Every human
// word in this file goes to stderr, which Claude Desktop shows in the
// extension's logs.
const log = (...parts) => console.error("[tama]", ...parts);

if (!url || !token) {
  log("missing configuration. Open Settings -> Extensions -> Tama and fill in the server address and device token.");
  process.exit(1);
}

log(`relaying to ${url}/mcp`);

// A line at a time, and deliberately not awaited in sequence. Claude Desktop
// issues tool calls in parallel, and awaiting each POST would make one slow
// search block a write that has nothing to do with it. JSON-RPC matches
// replies by id, so arrival order does not matter; `stdout.write` of one line
// is what keeps the interleaving safe.
const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    // Unparseable input can only come from a client bug or a corrupted pipe.
    // There is no id to answer with, so say so in the log and keep the pipe up.
    log("ignoring a line that was not JSON");
    return;
  }

  void relay(message, { url, token })
    .then((reply) => {
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    })
    .catch((error) => {
      // relay() answers its own failures, so reaching here is a bug in it
      // rather than a failure of the request. Never let one kill the pipe.
      log("relay threw, which it should not:", error instanceof Error ? error.message : error);
    });
});

// Claude Desktop closes stdin to stop the server. Exiting on that rather than
// waiting to be killed means in-flight replies are not cut off mid-line.
rl.on("close", () => process.exit(0));
