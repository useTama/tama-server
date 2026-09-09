import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../../src/db.ts";
import { KEEP_TURNS, SUMMARISE_AFTER, recall, remember, summarise } from "../../src/memory.ts";
import { judgeFreeLlm } from "./harness.ts";
import { THREADS } from "./threads.ts";

/**
 * Whether the summariser keeps what its own prompt promises to keep.
 *
 * `summarise()` is unmeasured lossy compression (#62). `SUMMARY_PROMPT` names
 * four things worth keeping and nothing asserted that a returned paragraph
 * contained any of them - `test/memory.test.ts` covers the fold, the count and
 * the atomic delete, but its model returns a canned string, so no test could
 * see what a real one writes.
 *
 * Judge-free, and therefore on the cheap gate. Every assertion below is a
 * substring check over one paragraph: "did the date survive", not "is this a
 * good summary". A small local model is enough:
 *
 *   TAMA_EVAL_LOCAL_MODEL=qwen2.5:0.5b-instruct bun run eval
 *
 * The failure this catches is the one that decays quietly. A summary that
 * drops what somebody is waiting on does not look broken - it looks like a
 * summary - and the next reply cheerfully suggests shipping.
 */

const llm = judgeFreeLlm();

describe.skipIf(!llm)("what the summariser keeps", () => {
  let dir: string;
  let db: Database;
  /** thread id -> the paragraph the model actually wrote. */
  const summaries = new Map<string, string>();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tama-memory-eval-"));
    db = openDb(join(dir, "tama.db"));

    for (const c of THREADS) {
      // A fold only happens above SUMMARISE_AFTER, which is a module constant
      // and not a parameter, so a thread that is too short silently folds
      // nothing and every probe below would grade an empty string.
      expect(c.turns.length).toBeGreaterThan(SUMMARISE_AFTER);

      for (const t of c.turns) remember(db, c.id, t.role, t.text, t.speaker);
      const folded = await summarise(db, c.id, llm!);
      expect(folded).toBe(true);

      const { summary } = recall(db, c.id);
      summaries.set(c.id, (summary ?? "").toLowerCase());
    }
  }, 300_000);

  afterAll(async () => {
    db?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  for (const c of THREADS) {
    test(`${c.id}: the fold reached the turns being measured`, () => {
      // Guards the fixture rather than the model. Every fact probed below has
      // to sit in the folded range: `summarise` folds `total - keep` from the
      // oldest end, so anything later than that is still verbatim in the tail
      // and the summary was never asked to carry it. A thread edited to be
      // shorter would make every probe below pass or fail for the wrong reason.
      const foldedThrough = c.turns.length - KEEP_TURNS;
      expect(foldedThrough).toBeGreaterThan(0);
      const kept = recall(db, c.id).turns;
      expect(kept.length).toBe(KEEP_TURNS);
      // The tail must not contain the facts, or the probes are measuring the
      // verbatim turns instead of the summary.
      const tail = kept.map((t) => t.text.toLowerCase()).join(" ");
      for (const p of c.probes) {
        const leaked = p.anyOf.every((group) => group.some((f) => tail.includes(f)));
        expect(leaked, `probe ${p.id} is satisfiable from the un-folded tail`).toBe(false);
      }
    });

    test(`${c.id}: the summary is a paragraph, not a report`, () => {
      const summary = summaries.get(c.id)!;
      expect(summary.length).toBeGreaterThan(40);
      // The prompt asks for one paragraph of plain text, at most 120 words.
      // Generous ceiling: this is a floor under compression, not a style
      // check, and a weak model padding to twice the limit is still a signal
      // that the instruction did not land.
      expect(summary.split(/\s+/).length).toBeLessThan(240);
      expect(summary).not.toContain("\n-");
      expect(summary).not.toContain("* ");
    });

    for (const p of c.probes) {
      test(`${c.id}: keeps the ${p.kind} (${p.id})`, () => {
        const summary = summaries.get(c.id)!;
        const missing = p.anyOf
          .filter((group) => !group.some((f) => summary.includes(f)))
          .map((group) => group.join(" | "));
        expect(missing, p.why).toEqual([]);
      });
    }
  }
});
