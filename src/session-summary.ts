/**
 * A coding session's transcript, turned into the session entry a person will
 * actually read weeks later.
 *
 * ## Why this exists on the server
 *
 * `record_session` already lets a model file an entry, and `/tama:save` lets
 * someone ask for one. Both need somebody to remember. The sessions worth
 * keeping are exactly the ones where the work was absorbing enough that nobody
 * thought about filing it, so the entries that never get written are the ones
 * that mattered most.
 *
 * A `SessionEnd` hook fires whether or not anyone remembered. It cannot ask a
 * model anything - the session it belongs to is already gone - so it ships the
 * material here and the server does the thinking. That is also the right place
 * for it: the vault's owner configured one model, and this way a summary costs
 * the same and reads the same however many machines they work from.
 *
 * ## The two failure modes this is shaped around
 *
 * **Filing nothing is better than filing noise.** A log whose entries say
 * "explored several approaches" costs a read to discover it is empty, and it
 * poisons retrieval for the entries that are not. So declining is a first-class
 * outcome here, not an error: `summariseSession` returns null and the caller
 * writes nothing.
 *
 * **A transcript is unbounded and a request is not.** A long session can be
 * megabytes, most of it tool output nobody will ever want summarised. The
 * client trims before sending and this trims again, because a cap that lives
 * only in a client is not a cap.
 */

import type { Llm, LlmUsage } from "./llm.ts";
import type { SessionEntry } from "./session.ts";

export type TranscriptTurn = { role: "user" | "assistant"; text: string };

/**
 * Characters of transcript the model is allowed to see.
 *
 * Chosen against the output cap rather than a context window: at
 * DEFAULT_MAX_OUTPUT_TOKENS the answer is a few hundred words whatever the
 * input, so spending more input buys less every time. It is also the number
 * that decides what a session costs, which is the thing an owner running this
 * on every session end will notice first.
 */
export const MAX_TRANSCRIPT_CHARS = 40_000;

/** One turn's ceiling, so a single pasted file cannot spend the whole budget. */
const MAX_TURN_CHARS = 4_000;

/**
 * The turns that fit, chosen from both ends.
 *
 * Not the last N. A session's first message states the task, and it is the
 * single most informative turn in the transcript - drop it and the summary
 * opens with the model inferring what the work was about from the middle of
 * it. Everything after that is filled backwards from the end, because the
 * outcome and the reasoning next to it are what an entry is for. The dropped
 * middle is where the searching happened, which is the part nobody asks about
 * later.
 */
export function boundTurns(
  turns: TranscriptTurn[],
  maxChars = MAX_TRANSCRIPT_CHARS,
): { kept: TranscriptTurn[]; dropped: number } {
  const clip = (t: TranscriptTurn): TranscriptTurn => ({
    role: t.role,
    text: t.text.length > MAX_TURN_CHARS ? `${t.text.slice(0, MAX_TURN_CHARS)}\n[...turn truncated]` : t.text,
  });

  const usable = turns.filter((t) => t.text?.trim()).map(clip);
  if (usable.length === 0) return { kept: [], dropped: 0 };

  const cost = (t: TranscriptTurn) => t.text.length + 16;

  const first = usable[0]!;
  if (usable.length === 1 || cost(first) >= maxChars) {
    return { kept: [first], dropped: usable.length - 1 };
  }

  let budget = maxChars - cost(first);
  const tail: TranscriptTurn[] = [];
  for (let i = usable.length - 1; i >= 1; i--) {
    const t = usable[i]!;
    if (cost(t) > budget) break;
    budget -= cost(t);
    tail.unshift(t);
  }
  return { kept: [first, ...tail], dropped: usable.length - 1 - tail.length };
}

/**
 * Written to be refused.
 *
 * Most of this prompt is about what not to write, because the failure here is
 * not a bad summary - it is a plausible one. A model handed a transcript will
 * always produce something, and something is what fills a log with entries
 * nobody wants. The `skip` escape hatch is named first and given examples, so
 * declining reads as the expected outcome rather than a failure to comply.
 */
const SESSION_PROMPT = `You are writing one entry in someone's engineering log, from the transcript of a
coding session they just finished. They will read it in six weeks, when they
remember the problem and not the diff.

Answer with one JSON object and nothing else. No prose around it, no code fence.

If the session reached nothing worth keeping, answer exactly:

  {"skip": true, "why": "<one short clause>"}

Skip when the session was a question and an answer, a command run, a file read,
an aborted start, or work that produced no decision and no outcome. Skipping is
the right answer often - more often than not. An entry that says "explored some
options" or "worked on the codebase" is worse than no entry, because it costs a
read to discover it is empty and it buries the entries that are not.

Otherwise answer:

  {
    "summary": "<a short paragraph>",
    "shipped": ["<what actually landed>"],
    "learned": ["<the non-obvious things>"],
    "next": ["<what the next session picks up>"]
  }

- summary: what was WRONG and why it mattered. Not what files changed. If a bug
  was fixed, the cause belongs here, especially when it was not where it looked.
- shipped: things that actually landed. Commits and working behaviour, not
  intentions. Omit the field if nothing landed.
- learned: the non-obvious. A cause in an unexpected place, a constraint found
  the hard way, an assumption that turned out false, a tool that does not behave
  as documented. This is the field worth the most later and the one most often
  left empty. Leave it empty only if nothing was actually learned.
- next: what is unfinished, including anything deliberately left undone and why.

Rules:
- Never write anything recoverable from git. The log has the diff; this has the
  reasoning.
- Write plainly, in the past tense, as the person themselves would. No headings,
  no bullet characters inside a string, no markdown emphasis.
- Do not invent. If the transcript does not say why something was done, do not
  supply a reason.
- Every list entry is one line. Three short entries beat one long one.`;

/**
 * The first JSON object in a model's reply.
 *
 * Fences and a leading sentence are both common enough to be the normal case
 * rather than an error, and both are cheap to survive. Balanced-brace scanning
 * rather than a regex, because a summary quoting a brace is not a reason to
 * lose the whole entry.
 */
export function extractJsonObject(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A model's list field, reduced to the lines that carry something. */
function asLines(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const lines = value
    .map((v) => String(v ?? "").replace(/\s+/g, " ").trim())
    .filter((v) => v.length > 1)
    .slice(0, 12);
  return lines.length ? lines : undefined;
}

export type SessionSummaryResult =
  | { filed: false; reason: string; usage?: LlmUsage }
  | { filed: true; entry: SessionEntry; dropped: number; usage?: LlmUsage };

/**
 * Summarise a transcript into an entry, or decline.
 *
 * Declining is not an error path. `filed: false` with a reason is what a
 * session that reached nothing is supposed to produce, and the caller writes
 * nothing and says so.
 */
export async function summariseSession(
  llm: Llm,
  opts: { project: string; turns: TranscriptTurn[]; at?: Date },
): Promise<SessionSummaryResult> {
  const { kept, dropped } = boundTurns(opts.turns);
  if (kept.length === 0) return { filed: false, reason: "the transcript had no text in it" };

  const rendered = kept
    .map((t) => `${t.role === "assistant" ? "assistant" : "them"}: ${t.text}`)
    .join("\n\n");
  const preamble = dropped > 0
    ? `This is the start and the end of the session; ${dropped} turns in the middle are omitted.\n\n`
    : "";

  let raw = "";
  let usage: LlmUsage | undefined;
  for await (const delta of llm.stream({
    system: SESSION_PROMPT,
    messages: [{ role: "user", content: `${preamble}Project: ${opts.project}\n\n${rendered}` }],
    onUsage: (u) => { usage = u; },
  })) {
    raw += delta;
  }

  const parsed = extractJsonObject(raw) as
    | { skip?: unknown; why?: unknown; summary?: unknown; shipped?: unknown; learned?: unknown; next?: unknown }
    | null;

  if (!parsed) {
    // The reply is kept out of the reason on purpose: it goes to a client and
    // into a log, and a whole failed completion in either is a wall.
    return { filed: false, reason: `the model did not answer with JSON (${raw.trim().slice(0, 120) || "empty reply"})`, usage };
  }
  if (parsed.skip === true) {
    const why = String(parsed.why ?? "").replace(/\s+/g, " ").trim();
    return { filed: false, reason: why || "nothing worth keeping", usage };
  }

  const summary = String(parsed.summary ?? "").replace(/\s+/g, " ").trim();
  const entry: SessionEntry = {
    project: opts.project,
    summary,
    ...(asLines(parsed.shipped) ? { shipped: asLines(parsed.shipped) } : {}),
    ...(asLines(parsed.learned) ? { learned: asLines(parsed.learned) } : {}),
    ...(asLines(parsed.next) ? { next: asLines(parsed.next) } : {}),
    ...(opts.at ? { at: opts.at } : {}),
  };

  // appendSession throws on an empty entry, and a model that answered with
  // neither a summary nor a list has effectively skipped without saying so.
  if (!entry.summary && !entry.shipped && !entry.learned && !entry.next) {
    return { filed: false, reason: "the model answered with an empty entry", usage };
  }
  return { filed: true, entry, dropped, usage };
}
