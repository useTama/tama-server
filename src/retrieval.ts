import { readdir, open } from "node:fs/promises";
import { visible, type View } from "./views.ts";
import { join } from "node:path";

/**
 * Retrieval over the vault, behind an interface.
 *
 * Markdown is canonical. There is no index here, on purpose: no embeddings, no
 * FTS5, no sidecar database. The implementation walks the files and scores what
 * it finds, which genuinely works at a few hundred notes, and it is a real
 * measurement rather than a guess because the notes are the only source of
 * truth. Building the embedding pipeline first would be solving the interesting
 * problem instead of the current one.
 *
 * The interface is the part that is meant to last. When a real question comes
 * back wrong, a second Retriever gets written and swapped in, and nothing that
 * consumes Chunk has to change. Until that happens, more machinery here is a
 * derived, disposable index that has to be kept correct for no measured gain.
 *
 * No subprocess. A grep(1) child would mean putting a user query on a command
 * line, and the query is untrusted text from the same pipeline as a transcript.
 * This project keeps untrusted text away from shells everywhere else (see
 * vault.ts), so it does not make an exception for the read path.
 */

export type Chunk = {
  path: string;
  text: string;
  score: number;
  capturedAt?: string;
};

export interface Retriever {
  /**
   * `view` bounds what may be seen. Applied during the walk, not to the
   * results: filtering afterwards spends a caller's chunk budget on notes it
   * cannot be shown, so a narrowed view would quietly return worse answers
   * rather than fewer, correct ones.
   */
  /**
   * `now` is the clock, injectable for the same reason `ask()` takes one: the
   * recency weight is measured against it, and a frozen fixture read with a
   * live clock scores every note as ancient - so the eval could never
   * constrain that weight, and what it did measure drifted every day the suite
   * ran. Left undefined everywhere in production.
   */
  search(query: string, limit?: number, view?: View, now?: number): Promise<Chunk[]>;
}

/**
 * Work caps. These exist so a single request cannot be turned into an
 * unbounded disk read by a vault that grew, a pasted logfile, or a stray
 * binary that someone named .md.
 *
 * 256 KiB is roughly 40k words, far past any hand-written or dictated note, so
 * in practice nothing is truncated. A file over the cap is truncated rather
 * than skipped: skipping would make a large note silently unfindable, and
 * silent invisibility is the failure this whole product exists to avoid.
 *
 * 2000 files is a deliberate order of magnitude above the design point. Hitting
 * it is not a tuning problem, it is the signal that this implementation has
 * outgrown its brief and the interface should be pointed at a real index.
 */
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 2000;
const DEFAULT_LIMIT = 8;

/** Characters that scan as part of a word, so a match boundary can be tested. */
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const TERM_PATTERN = /[\p{L}\p{N}]+/gu;
const DIGIT = /\p{N}/u;
const DIGITS_ONLY = /^\p{N}+$/u;

/**
 * Fold the two ways a spoken number reaches this differently from a typed one.
 *
 * Both sides of a search are Whisper output: the notes are transcripts, and a
 * question arriving as a voice note is a transcript too. Whisper is not
 * consistent about where a number ends, and every inconsistency cost the query
 * its most identifying term - "40,000" tokenised to "40" and "000", neither of
 * which matches "40000", and "p 95" tokenised to "95" and a dropped "p".
 *
 * Applied to the query here, and to a COPY of the note body by `foldBody`
 * below - both sides, because both sides are transcripts and folding only one
 * of them fixes half the cases by construction.
 */
/**
 * The same two folds applied to a note body, with a way back to the original
 * offsets.
 *
 * ## Why a copy and not a replacement
 *
 * The note body is searched TWICE: once as written, once folded, and the hits
 * are unioned. That is the whole design, and it is what makes this safe.
 *
 * Replacing the body with the folded text would fix the case this exists for
 * and break its mirror image. Folding deletes characters, so `findHits`'
 * digit-boundary rule starts applying where it did not: a note that writes
 * `events_2025_01_15` becomes `events_20250115`, and a query for `2025` then
 * has a digit on its right and stops matching - so the note loses its most
 * identifying term and comes back on generic words. That is precisely the
 * failure this function exists to fix, reintroduced in the other direction,
 * and it costs a note that used to be found. Measured at 8.59 to 4.50 on that
 * example, and to no match at all for `40 thousand` against `40,000 km`.
 *
 * Searching both forms and unioning cannot lose a hit. It can only add one,
 * because the as-written pass is still there unchanged. The per-term
 * `positions` set in `scoreNote` already deduplicates, so a term matching both
 * forms at the same place counts once and the repetition term does not inflate.
 *
 * ## Offsets
 *
 * Both folds delete characters, so folded-to-original is monotone and
 * injective: one entry per surviving character. `excerpt` and `bestWindow`
 * then keep working in original coordinates, which is why a hit found in the
 * folded text is translated before it is recorded.
 *
 * Returns null when nothing folds, which is every note in the fixture and
 * almost every note in a real vault - so the second pass is skipped entirely
 * in the common case.
 */
export function foldBody(lower: string): { text: string; toOriginal: (p: number) => number } | null {
  // No precheck. The obvious one - test the alternation before running it -
  // silently disagrees with the fold itself on this engine: on Bun 1.3.11
  // `/\p{N}[,_]\p{N}|\b[b-hj-z]\s+\p{N}/iu.test("b\u{1D7DD},5")` is false
  // while the same pattern without the alternation is true, so a guarded fold
  // would sometimes not happen. `matchAll` over a body with nothing to fold is
  // the same single scan the precheck would have been.
  const matches = [...lower.matchAll(/(\p{N})[,_](?=\p{N})|\b([b-hj-z])(\s+)(?=\p{N})/giu)];
  if (matches.length === 0) return null;

  const parts: string[] = [];
  const offsets = new Int32Array(lower.length);
  let n = 0;
  let last = 0;

  for (const m of matches) {
    // The span is derived from the match rather than from `index + 1`, because
    // `\p{N}` matches astral numerals: for those, the kept leading character
    // is two UTF-16 units and a fixed +1 lands inside the surrogate pair,
    // deleting half of it and leaving a lone surrogate in the scanned text.
    const dropTo = m.index + m[0].length;
    const dropFrom = dropTo - (m[1] !== undefined ? 1 : m[3]!.length);
    parts.push(lower.slice(last, dropFrom));
    for (let i = last; i < dropFrom; i++) offsets[n++] = i;
    last = dropTo;
  }
  parts.push(lower.slice(last));
  for (let i = last; i < lower.length; i++) offsets[n++] = i;

  const map = offsets.subarray(0, n);
  return {
    text: parts.join(""),
    // Clamped rather than trusted: a position past the end would be a bug
    // here, and returning the last real offset keeps `excerpt` in range.
    toOriginal: (pos: number) => map[Math.min(pos, map.length - 1)] ?? pos,
  };
}

export function normaliseNumbers(text: string): string {
  return (
    text
      // A separator between digits is not a boundary. The lookahead leaves the
      // trailing digit unconsumed, so one pass catches every group in
      // "1,234,567" rather than alternate ones.
      .replace(/(\p{N})[,_](?=\p{N})/gu, "$1")
      // "p 95" is p95: Whisper splits a metric's name from its number. "a" and
      // "i" are excluded because they are words - "a 5 minute walk" must not
      // become "a5 minute walk", which would both lose the 5 and invent a term.
      .replace(/\b([b-hj-z])\s+(?=\p{N})/giu, "$1")
  );
}

/**
 * Terms shorter than this are dropped before the stopword pass. Two characters
 * is the floor rather than three so "ai", "os" and "db" survive, which are real
 * things this vault talks about.
 */
const MIN_TERM_LENGTH = 2;

/**
 * A term this long or longer is matched with a left boundary only, so "recyklo"
 * finds "recyklos" without carrying a stemmer. Shorter terms need a boundary on
 * both sides, because suffix tolerance on "one" matches "ones" and also every
 * occurrence of "one" inside a longer word once the left boundary is the only
 * guard, which is how a short query starts returning noise.
 */
const SUFFIX_TOLERANT_LENGTH = 4;

/**
 * Not a linguistically complete stoplist and not trying to be. These are the
 * words that appear in nearly every note, so a hit on one carries no
 * information about which note is the right one.
 *
 * The two-letter entries matter more than they look. Without them "what is in
 * the box" scores on "is" and "in", which match the whole vault, and the
 * ranking is decided by whichever note happened to say "in" the most. Short
 * words that name real things ("ai", "os", "db", "go") are deliberately absent
 * so they stay searchable.
 */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "was", "were", "are", "you", "your",
  "but", "not", "from", "have", "has", "had", "what", "when", "where", "which",
  "who", "why", "how", "did", "does", "doing", "all", "any", "can", "about",
  "into", "its", "they", "them", "there", "then", "than", "been", "being",
  "will", "would", "should", "could", "just", "like", "some", "such", "only",
  "over", "also", "more", "most", "very", "his", "her", "their", "our", "out",
  "get", "got", "say", "said", "tell", "told", "know", "think", "want", "need",
  "is", "it", "in", "on", "at", "to", "of", "as", "be", "by", "an", "or", "if",
  "do", "so", "we", "me", "my", "he", "us", "am", "up", "no", "own",
]);

/**
 * Ranking weights. THIS IS THE TUNING POINT.
 *
 * The exact ranking was left undecided until implementation, so this is a pick,
 * not a result. The signals, in the order they matter:
 *
 *   coverage    how many DISTINCT query terms the note contains at all. Weighed
 *               highest because a note that touches every part of the question
 *               is almost always the answer.
 *   proximity   how many distinct terms land inside one excerpt-sized window.
 *               Separates a note that discusses the whole question in one place
 *               from a note that happens to mention each term in a different
 *               paragraph.
 *   path        distinct terms in the vault-relative path. Filenames here are a
 *               timestamp plus, later, a slug, so a filename hit is a strong
 *               statement about what the note is about.
 *   repetition  log2 of the raw hit count. Sublinear on purpose: a note that
 *               says one term forty times must not outrank a note that answers
 *               every part of the question once.
 *   recency     decayed frontmatter age, and only a tiebreaker. An old note
 *               that actually answers the question has to beat a fresh note
 *               that barely matches, so this can never dominate coverage.
 *
 * When an answer comes back wrong, change these numbers first and confirm the
 * ranking is the problem before reaching for embeddings.
 */
const W_COVERAGE = 6;
/**
 * Halved from 2, which closes the `latency` gap in the golden set.
 *
 * That case failed because a note explaining a thing does not repeat its name.
 * The investigation matched "latency" only in its filename and spread the rest
 * of the question across paragraphs, while a goals note stating "p95 latency
 * ... list endpoint" on one line collected the whole proximity bonus. This
 * weight was paying a compact restatement of a question more than a spread-out
 * answer to it.
 *
 * Swept one weight at a time across all 47 answerable cases. Recall and the
 * unanswerable floor never move; what moves is how much the right note wins by:
 *
 *   2     the answer loses
 *   1.5   wins by 0.002   <- closes the case, but a coin flip
 *   1     wins by 0.102
 *   0.5   wins by 0.202
 *   0     wins by 0.302
 *
 * 1.5 is the smallest change that passes and was rejected anyway: a margin of
 * 0.002 is one edited note away from flipping back, and a test that passes by
 * luck is worse than one that fails honestly.
 *
 * Zero used to pass everything too, which meant no case required proximity at
 * all and this weight was pinned from above only - a judgement dressed as a
 * measurement (#65). The `warmer` case now holds it up from below:
 * `Work/platform-misc.md` carries every term of that question, more often than
 * the answer does, and never two of them inside one window. Setting this to 0
 * makes that case fail and nothing else, so the number is now measured from
 * both sides. Same for W_RECENCY and the `snapshots` case.
 *
 * Raising W_PATH to 2 closes the same case and was not chosen: 2.5 pushes an
 * unanswerable question above the answerable median, so that lever sits one
 * step from a regression while this one has room on both sides.
 */
const W_PROXIMITY = 1;
const W_PATH = 1.5;
const W_REPETITION = 1;
const W_RECENCY = 1.5;

/** Half life for the recency term, in days. */
const RECENCY_HALF_LIFE_DAYS = 90;

/** Character span a single excerpt window may cover, plus the context on each side. */
const WINDOW_CHARS = 240;
const CONTEXT_CHARS = 80;

/**
 * Occurrences counted per term per note. A term repeated thousands of times in
 * one file would otherwise make window selection quadratic in a pathological
 * note for no ranking benefit, since repetition is already sublinear.
 */
const MAX_HITS_PER_TERM = 64;

/**
 * Split the query into scoring terms.
 *
 * If filtering removes everything, the unfiltered terms are used instead. A
 * query of nothing but short or common words ("why is it", "how do i") would
 * otherwise score zero notes and read to the user as "my note is gone", which
 * is a much worse answer than a weak one.
 */
function rawTerms(query: string): string[] {
  return Array.from(normaliseNumbers(query.toLowerCase()).matchAll(TERM_PATTERN), (m) => m[0]);
}

/**
 * The terms that carry information, with no fallback. Empty for a question made
 * entirely of common words.
 *
 * Separate from `tokenise` because the two answer different questions.
 * Searching wants something to search for even when the query is thin, which is
 * what the fallback below is for. Deciding whether a question can be searched
 * at all wants the truth: "what about that" has no subject, and the fallback
 * would report "what" and "about" as though it did.
 */
export function contentTerms(query: string): string[] {
  return dedupe(rawTerms(query).filter((t) => t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t)));
}

export function tokenise(query: string): string[] {
  const content = contentTerms(query);
  return content.length > 0 ? content : dedupe(rawTerms(query));
}

function dedupe(terms: string[]): string[] {
  return Array.from(new Set(terms));
}

/**
 * Strip a leading YAML frontmatter block and pull `captured:` out of it.
 *
 * Frontmatter is metadata, not content: it must not be scored and it must not
 * appear in an excerpt, or every result would open with the same three lines of
 * `source: voice`. The block only counts when the file opens with the fence, so
 * a note whose first line happens to be a horizontal rule does not lose its
 * body to a mis-parse.
 */
export function splitFrontmatter(raw: string): { body: string; capturedAt?: string } {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { body: raw };

  const meta = m[1] ?? "";
  const body = raw.slice(m[0].length);
  const captured = /^captured:[ \t]*(.+?)[ \t]*$/m.exec(meta)?.[1]?.replace(/^["']|["']$/g, "");

  // A hand-edited or half-written date is dropped rather than passed on. An
  // unparseable value would skew recency scoring and hand the caller a
  // capturedAt it cannot do arithmetic on.
  if (!captured || !Number.isFinite(Date.parse(captured))) return { body };

  // Returned verbatim, not re-serialised through Date. The vault writes a local
  // offset (see vault.ts renderNote) because a note taken at 11pm belongs to
  // that day, and normalising to UTC here would throw that away.
  return { body, capturedAt: captured };
}

/** 0 for missing or unparseable, 1 for right now, halving every half life. */
function recency(capturedAt: string | undefined, nowMs: number): number {
  if (!capturedAt) return 0;
  const t = Date.parse(capturedAt);
  if (!Number.isFinite(t)) return 0;
  // Clamped at zero so a future-dated note, or one written by a device with a
  // skewed clock, gets the maximum bonus and not an unbounded one.
  const ageDays = Math.max(0, (nowMs - t) / 86_400_000);
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && WORD_CHAR.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && DIGIT.test(ch);
}

/**
 * Positions where `term` occurs in already-lowercased `haystack`, as a word or
 * word prefix.
 *
 * A digits-only term gets its own boundary rule, because the rule for words is
 * wrong for numbers. "95" pressed against a letter is still 95 - Whisper writes
 * p95 as "p 95", so the query carries "95" and the note says "p95" - while "95"
 * pressed against another digit is a different number, which is what keeps 95
 * out of 1995 and 40 out of 40000.
 *
 * Suffix tolerance is off for numbers for the same reason: it exists so
 * "recyklo" finds "recyklos", and a plural is not a thing a number has.
 */
function findHits(haystack: string, term: string, cap: number): number[] {
  const out: number[] = [];
  const numeric = DIGITS_ONLY.test(term);
  const tolerateSuffix = !numeric && term.length >= SUFFIX_TOLERANT_LENGTH;
  let from = 0;
  while (out.length < cap) {
    const at = haystack.indexOf(term, from);
    if (at === -1) break;
    from = at + term.length;
    const before = haystack[at - 1];
    const after = haystack[from];
    if (numeric ? isDigit(before) : isWordChar(before)) continue;
    if (numeric ? isDigit(after) : !tolerateSuffix && isWordChar(after)) continue;
    out.push(at);
  }
  return out;
}

/**
 * A query term, plus the singular it may be the plural of.
 *
 * `findHits` tolerates a suffix on the NOTE, never on the query: needle
 * "recyklo" finds "recyklos", but needle "todos" can never find "todo". So
 * "what are my todos" scored exactly zero against a note full of "TODO:" lines
 * - the question this product exists to answer, missing the note that answers
 * it - while matching any note that merely used the word "todos" in prose.
 *
 * Deliberately not a stemmer. Trailing "s" and "es" cover the plural a spoken
 * question actually uses ("todos", "issues", "notes", "meetings"), and carrying
 * a real stemmer would mean carrying its false positives into a ranking that is
 * already the tuning point.
 *
 * "ss" and "us" endings are left alone. Stripping them yields "clas", "pres"
 * and "statu", which are long enough to be suffix-tolerant and would then match
 * "clash", "preset" and "statue" - noise on a word that was already correct.
 */
export function variants(term: string): string[] {
  if (term.endsWith("ss") || term.endsWith("us")) return [term];
  if (term.length >= 5 && term.endsWith("es")) return [term, term.slice(0, -2), term.slice(0, -1)];
  if (term.length >= 4 && term.endsWith("s")) return [term, term.slice(0, -1)];
  return [term];
}

type Hit = { pos: number; term: number };

/**
 * The window holding the most distinct terms, by a linear sweep.
 *
 * Ties keep the earliest window so the excerpt for a given note and query never
 * changes between runs. Every window is a subset of the widest valid window
 * ending at some hit, and distinctness only grows as a window widens, so the
 * maximum over those windows is the true maximum.
 */
function bestWindow(hits: Hit[]): { start: number; distinct: number } {
  const counts = new Map<number, number>();
  let lo = 0;
  let distinct = 0;
  let best = { start: 0, distinct: 0 };

  for (const hit of hits) {
    const seen = counts.get(hit.term) ?? 0;
    counts.set(hit.term, seen + 1);
    if (seen === 0) distinct++;

    for (;;) {
      const left = hits[lo];
      if (!left || hit.pos - left.pos <= WINDOW_CHARS) break;
      const leftCount = counts.get(left.term) ?? 0;
      if (leftCount === 1) distinct--;
      counts.set(left.term, leftCount - 1);
      lo++;
    }

    const left = hits[lo];
    if (left && distinct > best.distinct) best = { start: left.pos, distinct };
  }
  return best;
}

/** A readable slice around `start`, cut at whitespace so no word is halved. */
function excerpt(body: string, start: number): string {
  if (body.length === 0) return "";

  let from = Math.max(0, start - CONTEXT_CHARS);
  let to = Math.min(body.length, start + WINDOW_CHARS + CONTEXT_CHARS);

  if (from > 0) {
    const ws = body.slice(from, start).search(/\s/);
    if (ws !== -1) from += ws + 1;
  }
  if (to < body.length) {
    const tail = body.slice(start, to);
    const ws = tail.search(/\s\S*$/);
    if (ws > 0) to = start + ws;
  }

  const head = from > 0 ? "..." : "";
  const tail = to < body.length ? "..." : "";
  return head + body.slice(from, to).replace(/\n{3,}/g, "\n\n").trim() + tail;
}

/**
 * Score one note. Pure, and takes the clock as an argument rather than reading
 * it, so the recency term can be tested at a fixed instant.
 *
 * Returns null when nothing matched, which is also how a note with a body of
 * pure frontmatter drops out.
 */
export function scoreNote(
  relPath: string,
  raw: string,
  terms: string[],
  nowMs: number,
): Chunk | null {
  if (terms.length === 0) return null;

  const { body, capturedAt } = splitFrontmatter(raw);
  const lowerBody = body.toLowerCase();
  // A second view of the same text, with the two transcription folds applied.
  // Searched in addition to the body as written, never instead of it - see
  // `foldBody`. Null, and therefore free, for a note with nothing to fold.
  const folded = foldBody(lowerBody);
  const lowerPath = relPath.toLowerCase();

  const hits: Hit[] = [];
  let bodyDistinct = 0;
  let pathDistinct = 0;
  const matched = new Set<number>();

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (!term) continue;

    // Positions, not counts, and deduplicated: "todos" and "todo" both hit the
    // same offset in a note that says "todos", and counting it twice would
    // inflate the repetition term for a note that said the word once.
    const forms = variants(term);
    const positions = new Set<number>();
    for (const form of forms) {
      for (const pos of findHits(lowerBody, form, MAX_HITS_PER_TERM)) {
        positions.add(pos);
        if (positions.size >= MAX_HITS_PER_TERM) break;
      }
      if (positions.size >= MAX_HITS_PER_TERM) break;
    }
    // The folded view, translated back to original offsets. Additive by
    // construction: the pass above already ran, so this can only find a
    // position it missed - which is the whole point, and the reason no note
    // can drop out of results because of it. `positions` is a set, so a term
    // matching both views at the same place still counts once.
    if (folded && positions.size < MAX_HITS_PER_TERM) {
      for (const form of forms) {
        for (const pos of findHits(folded.text, form, MAX_HITS_PER_TERM)) {
          positions.add(folded.toOriginal(pos));
          if (positions.size >= MAX_HITS_PER_TERM) break;
        }
        if (positions.size >= MAX_HITS_PER_TERM) break;
      }
    }
    if (positions.size > 0) {
      bodyDistinct++;
      matched.add(i);
      // Every form scores under the same term index, so a note matching both
      // the plural and the singular still covers one term. Coverage is weighed
      // highest of all the signals; inflating it here would be the loudest
      // possible way to get this wrong.
      for (const pos of positions) hits.push({ pos, term: i });
    }
    if (forms.some((form) => findHits(lowerPath, form, 1).length > 0)) {
      pathDistinct++;
      matched.add(i);
    }
  }

  if (matched.size === 0) return null;

  hits.sort((a, b) => (a.pos !== b.pos ? a.pos - b.pos : a.term - b.term));
  const window = bestWindow(hits);

  const coverage = matched.size / terms.length;
  const proximity = bodyDistinct === 0 ? 0 : window.distinct / terms.length;
  const pathCoverage = pathDistinct / terms.length;

  const total =
    W_COVERAGE * coverage +
    W_PROXIMITY * proximity +
    W_PATH * pathCoverage +
    W_REPETITION * Math.log2(1 + hits.length) +
    W_RECENCY * recency(capturedAt, nowMs);

  // Rounded so equal scores are actually equal. Left as raw floats, two notes
  // that scored identically would differ in the last bit, the path tiebreak
  // below would never fire, and result order would be untestable.
  const score = Math.round(total * 1e4) / 1e4;

  // A path-only match still returns an excerpt from the top of the note. The
  // filename says the note is about this, so the opening lines are the most
  // useful thing to hand back.
  const text = excerpt(body, hits.length > 0 ? window.start : 0);

  return capturedAt
    ? { path: relPath, text, score, capturedAt }
    : { path: relPath, text, score };
}

/**
 * v1 retriever: walk the .md files, score them, return the best excerpts.
 *
 * Reads are sequential. At the design point of a few hundred notes that is
 * single-digit milliseconds of page-cached I/O, and the day it stops being
 * fast enough the fix is an index behind this interface, not a thread pool
 * bolted onto a full-vault scan.
 */
export class GrepRetriever implements Retriever {
  private maxFileBytes: number;
  private maxFiles: number;

  constructor(
    private vaultRoot: string,
    opts: { maxFileBytes?: number; maxFiles?: number } = {},
  ) {
    if (!vaultRoot) {
      throw new Error("GrepRetriever needs a vault root. pass config.vault.path");
    }
    this.maxFileBytes = positive(opts.maxFileBytes, DEFAULT_MAX_FILE_BYTES, "maxFileBytes");
    this.maxFiles = positive(opts.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  }

  async search(query: string, limit = DEFAULT_LIMIT, view?: View, nowMsIn?: number): Promise<Chunk[]> {
    const terms = tokenise(query);
    if (terms.length === 0) return [];

    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    const now = Number.isFinite(nowMsIn) ? (nowMsIn as number) : Date.now();

    const files: { abs: string; rel: string }[] = [];
    await this.collect(this.vaultRoot, "", files, view);

    const chunks: Chunk[] = [];
    for (const file of files) {
      const raw = await this.readCapped(file.abs);
      if (raw === null) continue;
      const chunk = scoreNote(file.rel, raw, terms, now);
      if (chunk) chunks.push(chunk);
    }

    // Path is the tiebreak, compared by code unit rather than localeCompare,
    // which is locale-dependent and would order results differently on two
    // machines running the same vault.
    chunks.sort((a, b) =>
      b.score !== a.score ? b.score - a.score : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    return chunks.slice(0, n);
  }

  /**
   * Depth-first, alphabetical, dotfiles and dot-directories skipped.
   *
   * .git is the obvious one. .tama is the one that matters: it holds Tama's own
   * write journal, and indexing it would feed the log of every vault write back
   * into an answer about the vault's contents.
   *
   * Symlinks are skipped outright, not followed. A symlinked directory can
   * point back up the tree and loop forever, or out of the vault entirely, and
   * a read path has no business reaching files the write path refuses to touch.
   *
   * Entries are sorted before the maxFiles cap is applied, so a vault over the
   * cap yields the same subset every run instead of whatever order the
   * filesystem happened to return.
   */
  private async collect(
    absDir: string,
    relDir: string,
    out: { abs: string; rel: string }[],
    view?: View,
  ): Promise<void> {
    if (out.length >= this.maxFiles) return;

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (relDir === "") {
        throw new Error(
          `cannot read vault root ${absDir} (${code ?? "unknown error"}).\n` +
            `  fix it: point vault.path in tama.config.json at an existing readable directory`,
        );
      }
      // A subdirectory can vanish or be unreadable while a walk is in flight,
      // including because a capture is landing right now. That is normal and
      // must not fail the request. Anything else is a real fault.
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return;
      throw e;
    }

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const e of entries) {
      if (out.length >= this.maxFiles) return;
      if (e.name.startsWith(".")) continue;
      if (e.isSymbolicLink()) continue;

      // Built with "/" rather than path.join so the vault-relative path in a
      // Chunk is the same string a note links to, on every platform.
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await this.collect(join(absDir, e.name), rel, out, view);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        // Per file rather than per directory: a view can exclude a subtree of a
        // folder it otherwise includes, so pruning the recursion on the
        // directory would drop notes the view admits.
        if (visible(rel, view)) out.push({ abs: join(absDir, e.name), rel });
      }
    }
  }

  /** Up to maxFileBytes of a file, or null if it disappeared or cannot be read. */
  private async readCapped(abs: string): Promise<string | null> {
    let fh;
    try {
      fh = await open(abs, "r");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EACCES" || code === "EPERM") return null;
      throw e;
    }
    try {
      const { size } = await fh.stat();
      const want = Math.min(size, this.maxFileBytes);
      if (want <= 0) return "";
      const buf = Buffer.allocUnsafe(want);
      const { bytesRead } = await fh.read(buf, 0, want, 0);
      // A cut in the middle of a multi-byte character decodes to a replacement
      // character. Harmless here: it is one glyph in one excerpt, and the
      // alternative is dropping the note from search entirely.
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`GrepRetriever ${name} must be a positive integer, got ${value}`);
  }
  return value;
}
