import { readdir, open } from "node:fs/promises";
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
  search(query: string, limit?: number): Promise<Chunk[]>;
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
const W_PROXIMITY = 2;
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
export function tokenise(query: string): string[] {
  const raw = Array.from(query.toLowerCase().matchAll(TERM_PATTERN), (m) => m[0]);
  const kept = raw.filter((t) => t.length >= MIN_TERM_LENGTH && !STOPWORDS.has(t));
  return dedupe(kept.length > 0 ? kept : raw);
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

/** Positions where `term` occurs in already-lowercased `haystack`, as a word or word prefix. */
function findHits(haystack: string, term: string, cap: number): number[] {
  const out: number[] = [];
  const tolerateSuffix = term.length >= SUFFIX_TOLERANT_LENGTH;
  let from = 0;
  while (out.length < cap) {
    const at = haystack.indexOf(term, from);
    if (at === -1) break;
    from = at + term.length;
    if (isWordChar(haystack[at - 1])) continue;
    if (!tolerateSuffix && isWordChar(haystack[from])) continue;
    out.push(at);
  }
  return out;
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
  const lowerPath = relPath.toLowerCase();

  const hits: Hit[] = [];
  let bodyDistinct = 0;
  let pathDistinct = 0;
  const matched = new Set<number>();

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    if (!term) continue;

    const found = findHits(lowerBody, term, MAX_HITS_PER_TERM);
    if (found.length > 0) {
      bodyDistinct++;
      matched.add(i);
      for (const pos of found) hits.push({ pos, term: i });
    }
    if (findHits(lowerPath, term, 1).length > 0) {
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

  async search(query: string, limit = DEFAULT_LIMIT): Promise<Chunk[]> {
    const terms = tokenise(query);
    if (terms.length === 0) return [];

    const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
    const now = Date.now();

    const files: { abs: string; rel: string }[] = [];
    await this.collect(this.vaultRoot, "", files);

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
        await this.collect(join(absDir, e.name), rel, out);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        out.push({ abs: join(absDir, e.name), rel });
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
