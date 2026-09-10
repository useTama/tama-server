/**
 * Conversation memory, per thread.
 *
 * Ask had none: every question arrived with no idea what the last one was, so
 * "and the other one?" was unanswerable and "roast him too" had no him. In a
 * one-to-one terminal that is tolerable. In a group where people talk to it
 * for ten minutes at a stretch it is the difference between a participant and
 * a vending machine.
 *
 * Three decisions worth stating.
 *
 * **It lives in the server, not the client.** The bridge could keep a buffer,
 * but then the iOS Shortcut and the web UI each need their own, and none of
 * them would agree. A thread is an opaque id the client supplies; the server
 * owns what it means to remember.
 *
 * **It is not the vault.** In a group these are other people's messages. They
 * are working state for answering the next one, not notes the owner wrote, and
 * a search must never return them. Hence a table rather than a file.
 *
 * **It is bounded by summarising, not by truncating.** Dropping the oldest
 * turns loses the thing that makes a long exchange coherent - what was agreed
 * twenty messages ago. Folding them into a paragraph keeps that at a fixed
 * cost.
 */

import type { Database } from "bun:sqlite";
import { spendLabel, type Llm, type LlmUsage } from "./llm.ts";
import { grey } from "./ui.ts";
import { contentTerms } from "./retrieval.ts";

/** Turns kept verbatim. Six exchanges is about as far back as "it" reaches. */
export const KEEP_TURNS = 12;

/** When to fold. Chosen so summarising is rare next to answering. */
export const SUMMARISE_AFTER = 30;

/** Per turn. A pasted logfile should not become permanent context. */
const MAX_TURN_CHARS = 2000;

/** Total per thread, so a runaway loop cannot grow the database unboundedly. */
const MAX_ROWS_PER_THREAD = 400;

export type Turn = { id: number; role: "user" | "assistant"; speaker?: string; text: string };
export type Recalled = { summary?: string; turns: Turn[] };

export function remember(
  db: Database,
  thread: string,
  role: "user" | "assistant",
  text: string,
  speaker?: string,
): void {
  const trimmed = text.trim();
  if (!thread || !trimmed) return;
  db.query("INSERT INTO conversation_turns (thread, role, speaker, text, at) VALUES (?, ?, ?, ?, ?)").run(
    thread,
    role,
    speaker ?? null,
    trimmed.slice(0, MAX_TURN_CHARS),
    new Date().toISOString(),
  );

  // A hard ceiling under the summariser, for the case where summarising is
  // failing: a broken model must not turn a chatty group into disk growth.
  const count = (db.query("SELECT count(*) AS n FROM conversation_turns WHERE thread = ?").get(thread) as { n: number }).n;
  if (count > MAX_ROWS_PER_THREAD) {
    db.query(
      `DELETE FROM conversation_turns WHERE thread = ? AND id IN (
         SELECT id FROM conversation_turns WHERE thread = ? ORDER BY id LIMIT ?
       )`,
    ).run(thread, thread, count - MAX_ROWS_PER_THREAD);
  }
}

export function recall(db: Database, thread: string, keep = KEEP_TURNS): Recalled {
  if (!thread) return { turns: [] };
  const summary = db
    .query("SELECT summary FROM conversation_summaries WHERE thread = ?")
    .get(thread) as { summary: string } | null;
  // Newest first from SQLite, then reversed: an index-ordered LIMIT is the
  // cheap way to take the tail.
  const rows = db
    .query("SELECT id, role, speaker, text FROM conversation_turns WHERE thread = ? ORDER BY id DESC LIMIT ?")
    .all(thread, keep) as Array<{ id: number; role: string; speaker: string | null; text: string }>;
  return {
    ...(summary?.summary ? { summary: summary.summary } : {}),
    turns: rows
      .reverse()
      .map((r) => ({
        id: r.id,
        role: r.role === "assistant" ? ("assistant" as const) : ("user" as const),
        ...(r.speaker ? { speaker: r.speaker } : {}),
        text: r.text,
      })),
  };
}

/**
 * Words that point at something already said instead of naming it.
 *
 * These are what make a question unable to stand alone, and they are not
 * stopwords: `contentTerms` keeps "other" and "one", so counting surviving
 * terms cannot tell "and the other one?" (two terms, both empty of subject)
 * from "when is the rent review" (two terms that are the subject).
 *
 * Deliberately only the pointing words. "last" and "next" are absent because
 * "what did I decide last week" is a real question about time, and the content
 * term beside them carries it anyway.
 */
const ANAPHORIC = new Set([
  "other", "ones", "one", "that", "this", "those", "these", "it", "them", "him", "her",
  "same", "else", "another", "again", "too", "both", "either", "neither", "such",
]);

/**
 * Terms that name a subject, rather than pointing back at one.
 *
 * `contentTerms` and not `tokenise`: the latter falls back to the raw words
 * when the stoplist empties a query, so "what about that" would report "what"
 * and "about" as substantive and be judged able to stand alone.
 */
function substantive(question: string): string[] {
  return contentTerms(question).filter((t) => !ANAPHORIC.has(t));
}

/**
 * Words that are contact rather than enquiry.
 *
 * Small, closed, and hand-maintained on purpose, exactly like `ANAPHORIC`
 * above. Anything not on this list keeps the old behaviour, so a word missing
 * from it costs nothing new; a word wrongly on it would make a real question
 * unanswerable, which is why nothing here can be the subject of a sentence.
 *
 * Hinglish included because the chat is. "haan", "theek" and "arre" arrive as
 * often as "ok" and "hey" do.
 */
const PLEASANTRIES = new Set([
  // greeting
  "hi", "hii", "hiii", "hey", "heya", "hello", "helo", "hlo", "yo", "sup", "wassup", "whatsup",
  "hola", "namaste", "oi", "oye", "gm", "gn", "morning", "night", "evening", "afternoon", "good",
  // acknowledgement
  "ok", "okay", "oki", "k", "kk", "thanks", "thanx", "thx", "ty", "cool", "nice", "great",
  "fine", "sure", "yes", "yeah", "yep", "yup", "nope", "haan", "han", "nahi", "nai",
  "theek", "thik", "achha", "acha", "accha", "sahi", "badhiya", "bas", "done",
  // interjection
  "bruh", "bro", "bhai", "dude", "man", "lol", "lmao", "haha", "hahaha", "hehe", "hmm", "hm",
  "hmmm", "arre", "arey", "oof", "ugh", "oops", "wow",
]);

/**
 * Whether a message is contact rather than a question about the notes.
 *
 * This is the other half of #57. That fix stopped a question with its own
 * subject being polluted by the previous one, by carrying prior turns only when
 * the question has fewer than two substantive terms. Correct for anaphora, and
 * a greeting has zero substantive terms too, so "hi" took the same branch:
 * retrieve whatever they were last talking about, and report it. The bare name
 * of the assistant came back with an unrelated open issue; "sup" came back with
 * a deadline and a build status. That reads as a slot machine, not as recall.
 *
 * Conservative by construction. Every remaining word must be a pleasantry, so
 * "hi what about the mic" is still a question and only a message that is
 * nothing but contact is treated as one.
 *
 * `selfName` is here because being addressed by name is the same act as saying
 * hello, and the name is whatever the owner called their world. Without it,
 * "tama" is a substantive term that matches its own project notes.
 */
export function isSmallTalk(question: string, selfName?: string): boolean {
  const words = question
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return false;

  const self = selfName?.trim().toLowerCase();
  return words.every(
    (w) => PLEASANTRIES.has(w) || (self !== undefined && self.length > 0 && w === self),
  );
}

/**
 * What to search the vault for, given a question that may not stand alone.
 *
 * `GrepRetriever` scores on word overlap, so "and the other one?" retrieves
 * nothing: it contains no word from any note. Carrying the recent user turns
 * into the query is the cheap fix - no extra model call - and it recovers most
 * of what a proper rewrite (#23) would, because the words that matter were
 * usually said a message or two ago.
 *
 * Carried *conditionally*, which is #57. Doing it unconditionally was right for
 * the follow-up and wrong for a change of subject: ask about the mic gain, get
 * an answer, then ask "when is the rent review", and the search ran on "mic
 * gain rent review" - two stale discriminating terms against one live one.
 * Coverage is the heaviest signal, so the mic note could cover two of three
 * terms and outrank the rent note that covered one. There was no symptom: a
 * note was retrieved, an answer was produced, and it cited something plausible.
 *
 * Two substantive terms is the threshold. One is not enough: "roast him too"
 * has only "roast" and still needs to know who, and the same holds for "what
 * about the mic" when the mic was three messages ago.
 *
 * The tokeniser is the retriever's own, not a copy. A threshold that decides
 * whether a question can be searched has to split words the way the thing doing
 * the searching splits them, or the decision is about a query nobody runs.
 *
 * Only user turns. The assistant's own words are drawn from the notes, so
 * feeding them back would score those same notes higher for reasons that have
 * nothing to do with the question.
 */
export function searchQuery(
  question: string,
  turns: Turn[],
  opts: { lookBack?: number; selfName?: string } = {},
): string | null {
  // Null rather than a query, because "search for nothing" and "do not search"
  // are different and only one of them should make the model say the notes
  // were empty. Checked before the carry-forward branch below, which is the
  // branch it used to fall into.
  if (isSmallTalk(question, opts.selfName)) return null;

  if (substantive(question).length >= 2) return question.slice(0, 1000);
  const recent = turns
    .filter((t) => t.role === "user")
    .slice(-(opts.lookBack ?? 2))
    .map((t) => t.text);
  return [...recent, question].join(" ").slice(0, 1000);
}

/** The prior exchange, as messages, with speakers named where a room has several. */
export function asMessages(turns: Turn[]): Array<{ role: "user" | "assistant"; content: string }> {
  return turns.map((t) => ({
    role: t.role,
    content: t.role === "user" && t.speaker ? `${t.speaker}: ${t.text}` : t.text,
  }));
}

const SUMMARY_PROMPT = `You are compressing a chat log so a later reply can stay coherent.

Write one paragraph, at most 120 words, in plain text. Keep: what was decided, what was asked and
answered, names and who said what, anything someone is waiting on, and any running joke or
nickname that would make a later reply make sense. Drop: greetings, filler, and anything nobody
would refer back to.

Write it as notes to yourself, not as a report to a reader. No preamble, no bullet points, no
"the conversation covered". If an earlier summary is given, rewrite it together with the new
messages into one paragraph rather than appending.`;

/**
 * Fold everything but the kept tail into a paragraph.
 *
 * Called after answering, never before: summarising is a model call, and making
 * someone wait for it to reply to "haan" would be the wrong trade. If it fails,
 * the turns stay and it is tried again next time, so a broken model costs
 * memory depth rather than the conversation.
 */
export async function summarise(db: Database, thread: string, llm: Llm, keep = KEEP_TURNS): Promise<boolean> {
  const total = (db.query("SELECT count(*) AS n FROM conversation_turns WHERE thread = ?").get(thread) as { n: number }).n;
  if (total <= SUMMARISE_AFTER) return false;

  const stale = db
    .query("SELECT id, role, speaker, text FROM conversation_turns WHERE thread = ? ORDER BY id LIMIT ?")
    .all(thread, total - keep) as Array<{ id: number; role: string; speaker: string | null; text: string }>;
  if (stale.length === 0) return false;

  const existing = db.query("SELECT summary FROM conversation_summaries WHERE thread = ?").get(thread) as
    | { summary: string }
    | null;

  const transcript = stale
    .map((t) => `${t.role === "assistant" ? "you" : t.speaker ?? "them"}: ${t.text}`)
    .join("\n");

  let summary = "";
  let usage: LlmUsage | undefined;
  try {
    for await (const delta of llm.stream({
      system: SUMMARY_PROMPT,
      messages: [
        {
          role: "user",
          content: existing?.summary
            ? `Earlier summary:\n${existing.summary}\n\nNew messages:\n${transcript}`
            : transcript,
        },
      ],
      onUsage: (u) => { usage = u; },
    })) {
      summary += delta;
    }
  } catch {
    return false;
  }
  if (!summary.trim()) return false;

  const through = stale[stale.length - 1]!.id;
  // One transaction: a summary written without its turns deleted would double
  // the history, and turns deleted without a summary would lose it.
  db.transaction(() => {
    db.query(
      `INSERT INTO conversation_summaries (thread, summary, through_id, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread) DO UPDATE SET summary = excluded.summary, through_id = excluded.through_id, updated_at = excluded.updated_at`,
    ).run(thread, summary.trim(), through, new Date().toISOString());
    db.query("DELETE FROM conversation_turns WHERE thread = ? AND id <= ?").run(thread, through);
  })();
  // Fired from a void call after a reply has already gone out, so nothing
  // downstream would ever have reported this one. A busy chat summarises on a
  // schedule of its own and spent nothing visible while doing it.
  const spend = spendLabel(usage);
  if (spend) console.log(`${grey("summarise")} ${grey(`${stale.length} turns folded${spend} <${thread}>`)}`);
  return true;
}

/** For a caller that wants to start over, and for tests. */
export function forget(db: Database, thread: string): void {
  db.query("DELETE FROM conversation_turns WHERE thread = ?").run(thread);
  db.query("DELETE FROM conversation_summaries WHERE thread = ?").run(thread);
}
