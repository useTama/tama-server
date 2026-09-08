#!/usr/bin/env node
/**
 * Files a session in the vault when the session ends, if anything happened.
 *
 * ## Why a hook at all
 *
 * `record_session` and `/tama:save` both need somebody to remember, and the
 * sessions worth keeping are the absorbing ones where nobody thought about
 * filing anything. So the entries that never got written were the ones that
 * mattered most. This fires whether or not anyone remembered.
 *
 * ## Why it posts rather than thinks
 *
 * A SessionEnd hook is a shell command running after its session is gone. It
 * cannot ask a model anything. The obvious workaround - shell out to `claude
 * -p` to write the summary - has a trap in it: that invocation is itself a
 * session, so it ends, so this hook fires again. Posting the material to the
 * server instead has no such edge, costs one call on the key the owner already
 * configured, and reads the same from every machine they work from.
 *
 * ## Why it is quiet
 *
 * It cannot block - the session is already over - and most sessions file
 * nothing, which is the intended outcome and not worth a line of output. So it
 * says something only when an entry was actually written, and every failure
 * goes to stderr, where Claude Code keeps it in the extension's log rather than
 * in the user's way.
 */

import { readFile } from "node:fs/promises";
import { turnsFrom, projectFrom, shouldFile, trimToWire } from "./transcript.mjs";

const [, , serverUrl, token, autoSave] = process.argv;

/** stderr, not stdout: stdout is the hook's JSON channel. */
const log = (...parts) => console.error("[tama]", ...parts);

// Off unless the owner turned it on. Every exit in this file is 0: a hook that
// fails a session teardown is worse than a hook that files nothing.
if (autoSave !== "true") process.exit(0);
if (!serverUrl || !token) {
  log("automatic session recording is on but the server address or token is not set");
  process.exit(0);
}

async function main() {
  const raw = await new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
    // No stdin at all rather than empty stdin happens when a hook is run by
    // hand. Answering after a beat beats hanging until the timeout.
    setTimeout(() => resolve(buf), 5000);
  });

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("no hook payload on stdin");
    return;
  }

  if (!shouldFile(payload.reason)) {
    log(`not filing: reason was ${payload.reason}`);
    return;
  }

  const project = projectFrom(payload.cwd);
  if (!project) {
    log("no cwd in the payload, so there is no project to file under");
    return;
  }
  if (!payload.transcript_path) {
    log("no transcript_path in the payload");
    return;
  }

  let lines;
  try {
    lines = (await readFile(payload.transcript_path, "utf8")).split("\n");
  } catch (error) {
    log("could not read the transcript:", error?.message ?? error);
    return;
  }

  const all = turnsFrom(lines);
  const turns = trimToWire(all);
  if (all.length < 2) {
    // One turn is a question, or a session that opened and closed. There is
    // nothing to summarise and no reason to spend a model call finding out.
    log(`not filing: ${all.length} conversational turn(s)`);
    return;
  }

  let res;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, "")}/sessions/from-transcript`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        // The session id, so a retry - or a second machine syncing the same
        // session - appends one entry rather than two.
        ...(payload.session_id ? { "idempotency-key": `session-end:${payload.session_id}` } : {}),
      },
      body: JSON.stringify({ project, turns }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    log("could not reach Tama:", error?.message ?? error);
    return;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    log(`Tama refused the transcript: ${res.status} ${body.error ?? ""}`.trim());
    return;
  }
  if (!body.filed) {
    log(`nothing filed: ${body.reason ?? "the session reached nothing worth keeping"}`);
    return;
  }

  log(`filed ${body.relPath} from ${turns.length} of ${all.length} turns`);
  // The one thing worth saying out loud, and only because a note appearing in
  // a git repo with no explanation is worse than a line saying it happened.
  process.stdout.write(JSON.stringify({ systemMessage: `Tama recorded this session in ${body.relPath}` }) + "\n");
}

main().catch((error) => {
  log("hook failed:", error?.message ?? error);
  process.exit(0);
});
