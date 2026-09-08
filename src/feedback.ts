/**
 * A record of answers the owner said were wrong.
 *
 * #60. The golden set holds 47 cases and every one of them was imagined in
 * advance, so #20, #49 and #54 are all judged against a fixture vault written
 * to test them. That is the right way to start and it cannot be the whole
 * story: the questions that matter are the ones a real vault gets asked, and
 * until now none of them was ever seen again. Three genuine failures turned up
 * in ordinary use recently - a question about an error matching a note about a
 * GitHub issue, "what are my todos" missing the file full of TODO lines, a
 * group reply that could not say who was talking - and every one had to be
 * reproduced by hand from a screenshot.
 *
 * Four things this deliberately is not.
 *
 * **Not telemetry.** It is a file on the owner's disk and nothing sends it
 * anywhere. There is no collection endpoint and there should never be one.
 *
 * **Not a training set.** It is a notebook of complaints, read by a person
 * deciding what to add to `golden.ts`. Promotion is a human judgement, because
 * a golden set anything can write to is not golden.
 *
 * **Not the answer.** The question and the retrieved paths are enough to
 * reproduce a bad answer and to triage it. Keeping answers would grow a second
 * copy of the vault's content somewhere with none of the vault's rules.
 *
 * **Not open to the room.** Only the owner may mark an answer wrong. In a group
 * the question is often someone else's message, and this file is permanent
 * where `conversation_turns` is not - so a stranger could otherwise both fill
 * it with other people's words and poison what the eval set gets built from.
 */

import type { Database } from "bun:sqlite";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Retained per thread. Enough to react to a reply that is a few messages back. */
const KEEP_PER_THREAD = 10;

export type AskRecord = {
  id: string;
  thread: string;
  question: string;
  sources: Array<{ path: string; score: number }>;
};

/**
 * Remember what a question retrieved, so feedback arriving later can name it.
 *
 * The server has to hold this rather than the client echoing it back. An
 * audience with `cite: false` is never told the paths at all - that is the
 * point of the setting - so a client cannot report what it was deliberately not
 * given, and trusting it to would mean accepting paths it should not know.
 */
export function recordAsk(db: Database, ask: AskRecord): void {
  if (!ask.thread || !ask.question.trim()) return;
  db.query(
    "INSERT OR REPLACE INTO asks (id, thread, question, sources, at) VALUES (?, ?, ?, ?, ?)",
  ).run(ask.id, ask.thread, ask.question.trim(), JSON.stringify(ask.sources), new Date().toISOString());

  // Bounded per thread rather than globally, so a busy group cannot age out
  // the answer the owner is about to react to in a quiet one.
  db.query(
    `DELETE FROM asks WHERE thread = ? AND id NOT IN (
       SELECT id FROM asks WHERE thread = ? ORDER BY at DESC, id DESC LIMIT ?
     )`,
  ).run(ask.thread, ask.thread, KEEP_PER_THREAD);
}

/** The ask a piece of feedback refers to: named outright, or the latest one. */
export function findAsk(db: Database, thread: string, askId?: string): AskRecord | null {
  const row = (askId
    ? db.query("SELECT id, thread, question, sources FROM asks WHERE id = ? AND thread = ?").get(askId, thread)
    : db.query("SELECT id, thread, question, sources FROM asks WHERE thread = ? ORDER BY at DESC, id DESC LIMIT 1").get(thread)
  ) as { id: string; thread: string; question: string; sources: string } | null;
  if (!row) return null;
  let sources: AskRecord["sources"] = [];
  try {
    sources = JSON.parse(row.sources) as AskRecord["sources"];
  } catch {
    // A corrupt row still names a question worth writing down. Losing the
    // paths costs triage; refusing the whole record costs the case.
  }
  return { id: row.id, thread: row.thread, question: row.question, sources };
}

export type Verdict = "wrong" | "right";

/** One line of the notebook. Shaped so a golden case can be written from it. */
export type FeedbackEntry = {
  at: string;
  verdict: Verdict;
  question: string;
  /** What retrieval actually returned, which is usually where the fault is. */
  retrieved: Array<{ path: string; score: number }>;
  /** Whatever the owner added, if they said anything. */
  note?: string;
};

export function feedbackPath(dataDir: string): string {
  return join(dataDir, "feedback.jsonl");
}

/**
 * Append one verdict.
 *
 * JSONL because the consumer is a person opening the file and deciding what
 * belongs in `golden.ts`. A table would need a query to read and a formatter to
 * print; a line per complaint can be read, grepped, and pasted.
 */
export async function recordFeedback(
  dataDir: string,
  entry: FeedbackEntry,
): Promise<void> {
  const path = feedbackPath(dataDir);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}
