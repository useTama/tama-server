import { describe, test, expect } from "bun:test";
import { ANSWERABLE, UNANSWERABLE } from "./golden.ts";
import { unsupportedCitations, citedPaths } from "./metrics.ts";
import { answerer, judgeFreeLlm, paidLlm } from "./harness.ts";

/**
 * The half of the eval that needs a model.
 *
 * Gated rather than mocked. A mocked model tests the plumbing, which
 * routes.test.ts already does; the questions here are about a real model's
 * behaviour on real retrieved context, and there is no way to ask them
 * without asking one.
 *
 * Two gates, because there are two kinds of check here and one gate used to
 * hold both (#61). See `harness.ts` for which model each gets.
 */

const judgeFree = judgeFreeLlm();
const paid = paidLlm();

/**
 * Judge-free, and therefore cheap enough to want running often.
 *
 * Every assertion below is a string predicate over an answer. They need *a*
 * model to produce one, not a good one, so a free local model satisfies them:
 *
 *   TAMA_EVAL_LOCAL_MODEL=qwen2.5:0.5b-instruct bun run eval
 *
 * A weak model will give worse answers than a real one and it does not matter,
 * because the assertion is never "is this answer good".
 */
describe.skipIf(!judgeFree)("citations and refusals, against any model", () => {
  const run = answerer(judgeFree!);

  /**
   * Citation accuracy. Every path in the answer has to be a path the model was
   * shown, because a fabricated filename is a fabricated source - and a model
   * willing to construct a filename will construct the fact underneath it.
   */
  for (const c of ANSWERABLE) {
    test(`cites only what it was shown: ${c.id}`, async () => {
      const { answer, sources } = await run(c.q);
      expect(unsupportedCitations(answer, sources.map((s) => s.path))).toEqual([]);
    }, 120_000);
  }

  /**
   * Refusal correctness. This is the one the whole product rests on: a second
   * brain that invents a memory is worse than no second brain, because you
   * cannot tell which memories are yours.
   *
   * Judge-free on purpose. "Did it cite anything" and "did it say the number
   * it could not have known" are both decidable without asking a model's
   * opinion of another model.
   */
  for (const c of UNANSWERABLE) {
    test(`refuses: ${c.id}`, async () => {
      const { answer } = await run(c.q);
      // Nothing supports the answer, so nothing may be cited in support of it.
      expect(citedPaths(answer)).toEqual([]);
      if (c.fabricationTell) expect(answer).not.toMatch(c.fabricationTell);
    }, 120_000);
  }
});

/**
 * The half that needs a model good enough to be judged.
 *
 *   TAMA_EVAL_MODEL=anthropic/claude-sonnet-5 \
 *   TAMA_EVAL_KEY=sk-... \
 *   TAMA_EVAL_BASE_URL=https://openrouter.ai/api/v1 \
 *   bun run eval
 *
 * Still not in CI, and this is the part that should stay out: it costs a few
 * cents a run and would fail on a rate limit rather than on a regression.
 */
describe.skipIf(!paid)("faithfulness, against a model worth judging", () => {
  const run = answerer(paid!);

  /**
   * Faithfulness, in the cheap approximation: the answer contains the specific
   * the note contains. Not a judge, so it cannot catch a wrong answer that
   * happens to include the right number, but it does catch the common failure
   * of answering around the question with the note in hand.
   *
   * Deliberately NOT in the judge-free group. A small model misses a specific
   * on its own weakness rather than on any regression, and a check that goes
   * red for reasons nobody believes stops being read at all - which is worse
   * than the no-signal it replaced.
   */
  for (const c of ANSWERABLE.filter((c) => c.gist)) {
    test(`says the specific: ${c.id}`, async () => {
      const { answer } = await run(c.q);
      const lower = answer.toLowerCase();
      const missing = c.gist!.filter((g) => !lower.includes(g.toLowerCase()));
      expect(missing).toEqual([]);
    }, 60_000);
  }
});
