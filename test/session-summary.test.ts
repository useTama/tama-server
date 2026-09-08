/**
 * The summariser, and mostly its refusals.
 *
 * A `SessionEnd` hook fires on every session, so the thing that decides whether
 * anything gets written is the only thing standing between an engineering log
 * and a list of entries saying "worked on the codebase". These tests are about
 * that decision far more than about the summary.
 */

import { expect, test } from "bun:test";
import { boundTurns, extractJsonObject, summariseSession, MAX_TRANSCRIPT_CHARS } from "../src/session-summary.ts";
import type { Llm } from "../src/llm.ts";

/** An Llm that answers with whatever the test wants, and records what it saw. */
function fakeLlm(reply: string) {
  const seen: Array<{ system: string; content: string }> = [];
  const llm: Llm = {
    name: "fake",
    async *stream(opts) {
      seen.push({ system: opts.system, content: opts.messages[0]?.content ?? "" });
      // Two deltas, so a caller that forgets to accumulate fails here.
      yield reply.slice(0, Math.ceil(reply.length / 2));
      yield reply.slice(Math.ceil(reply.length / 2));
    },
  };
  return { llm, seen };
}

const turn = (role: "user" | "assistant", text: string) => ({ role, text });

test("a session that reached nothing files nothing, and says why", async () => {
  const { llm } = fakeLlm('{"skip": true, "why": "one question, one answer, no decision"}');
  const result = await summariseSession(llm, { project: "tama", turns: [turn("user", "what is in routes.ts")] });

  expect(result.filed).toBe(false);
  if (!result.filed) expect(result.reason).toBe("one question, one answer, no decision");
});

test("a real session becomes an entry with the fields that were answered", async () => {
  const { llm } = fakeLlm(JSON.stringify({
    summary: "The bridge crash-looped because the image never copied http-error.mjs.",
    shipped: ["COPY *.mjs so a new module cannot be forgotten"],
    learned: ["A dead client looks exactly like a dead server from the phone"],
    next: [],
  }));
  const result = await summariseSession(llm, { project: "tama-server", turns: [turn("user", "why is it broken")] });

  expect(result.filed).toBe(true);
  if (result.filed) {
    expect(result.entry.project).toBe("tama-server");
    expect(result.entry.summary).toContain("crash-looped");
    expect(result.entry.shipped).toHaveLength(1);
    expect(result.entry.learned).toHaveLength(1);
    // An empty list is dropped rather than written as a heading with nothing
    // under it.
    expect(result.entry.next).toBeUndefined();
  }
});

test("a model that answers with prose instead of JSON files nothing", async () => {
  // Not an exception. The hook fires on every session end and must be able to
  // tell "nothing to say" from "something broke" without reading a message,
  // but neither one may throw.
  const { llm } = fakeLlm("Sure! Here's a summary of your session: you fixed a bug.");
  const result = await summariseSession(llm, { project: "tama", turns: [turn("user", "x")] });

  expect(result.filed).toBe(false);
  if (!result.filed) expect(result.reason).toContain("did not answer with JSON");
});

test("a fenced object is still an object", async () => {
  const { llm } = fakeLlm('Here you go:\n```json\n{"summary": "Fixed the tunnel."}\n```\n');
  const result = await summariseSession(llm, { project: "tama", turns: [turn("user", "x")] });
  expect(result.filed).toBe(true);
  if (result.filed) expect(result.entry.summary).toBe("Fixed the tunnel.");
});

test("an answer with a summary and no lists is still worth filing", async () => {
  const { llm } = fakeLlm('{"summary": "Decided against FTS5 until the scan is actually slow."}');
  const result = await summariseSession(llm, { project: "tama", turns: [turn("user", "x")] });
  expect(result.filed).toBe(true);
});

test("an answer that is empty in every field files nothing", async () => {
  // appendSession throws on this, and a model that answers with neither a
  // summary nor a list has skipped without saying so.
  const { llm } = fakeLlm('{"summary": "", "shipped": [], "learned": [], "next": []}');
  const result = await summariseSession(llm, { project: "tama", turns: [turn("user", "x")] });
  expect(result.filed).toBe(false);
  if (!result.filed) expect(result.reason).toContain("empty entry");
});

test("a transcript with no text in it never reaches the model", async () => {
  const { llm, seen } = fakeLlm('{"skip": true}');
  const result = await summariseSession(llm, { project: "tama", turns: [turn("user", "   "), turn("assistant", "")] });
  expect(result.filed).toBe(false);
  // The point: no request was made, so an empty hook payload costs nothing.
  expect(seen).toHaveLength(0);
});

test("the first turn survives a transcript far over the cap", () => {
  // The first message states the task and is the most informative turn there
  // is. Keeping the last N instead means the summary opens with the model
  // inferring what the work was from the middle of it.
  const turns = [turn("user", "FIRST: make the bridge stop crash-looping")];
  for (let i = 0; i < 400; i++) turns.push(turn("assistant", "x".repeat(500)));
  turns.push(turn("assistant", "LAST: fixed by copying every module"));

  const { kept, dropped } = boundTurns(turns);
  expect(kept[0]!.text).toContain("FIRST");
  expect(kept[kept.length - 1]!.text).toContain("LAST");
  expect(dropped).toBeGreaterThan(0);
  expect(kept.map((t) => t.text).join("").length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
});

test("one enormous turn cannot spend the whole budget", () => {
  const turns = [
    turn("user", "the task"),
    turn("assistant", "y".repeat(200_000)),
    turn("assistant", "the outcome"),
  ];
  const { kept } = boundTurns(turns);
  expect(kept[0]!.text).toBe("the task");
  expect(kept[kept.length - 1]!.text).toBe("the outcome");
  // The giant middle turn is clipped rather than allowed to evict the ends.
  const giant = kept.find((t) => t.text.startsWith("y"));
  if (giant) expect(giant.text).toContain("turn truncated");
});

test("the model is told when the middle was dropped", async () => {
  const turns = [turn("user", "the task")];
  for (let i = 0; i < 300; i++) turns.push(turn("assistant", "z".repeat(400)));
  const { llm, seen } = fakeLlm('{"skip": true}');
  await summariseSession(llm, { project: "tama", turns });
  // Otherwise it reads a jump in the conversation as the conversation.
  expect(seen[0]!.content).toContain("turns in the middle are omitted");
});

test("declining is named first in the prompt, and given examples", async () => {
  // This is the whole defence against a log of empty entries, so it is worth a
  // test that fails if someone softens it.
  const { llm, seen } = fakeLlm('{"skip": true}');
  await summariseSession(llm, { project: "tama", turns: [turn("user", "x")] });
  const system = seen[0]!.system;
  expect(system).toContain('"skip": true');
  expect(system).toContain("Skipping is");
  expect(system).toContain("worse than no entry");
});

test("extractJsonObject survives a brace inside a string", () => {
  expect(extractJsonObject('{"summary": "the config had a stray { in it"}'))
    .toEqual({ summary: "the config had a stray { in it" });
  expect(extractJsonObject('{"summary": "an escaped quote \\" and a brace }"}'))
    .toEqual({ summary: 'an escaped quote " and a brace }' });
  expect(extractJsonObject("no object here")).toBeNull();
  expect(extractJsonObject('{"broken": ')).toBeNull();
});
