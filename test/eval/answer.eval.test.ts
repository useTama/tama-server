import { describe, test, expect } from "bun:test";
import { askOnce } from "../../src/ask.ts";
import { GrepRetriever } from "../../src/retrieval.ts";
import { makeLlm, type LlmConfig } from "../../src/llm.ts";
import { ANSWERABLE, UNANSWERABLE } from "./golden.ts";
import { unsupportedCitations, citedPaths } from "./metrics.ts";

/**
 * The half of the eval that needs a model, and therefore money.
 *
 * Gated rather than mocked. A mocked model tests the plumbing, which
 * routes.test.ts already does; the questions here are about a real model's
 * behaviour on real retrieved context, and there is no way to ask them
 * without asking one.
 *
 *   TAMA_EVAL_MODEL=anthropic/claude-sonnet-5 \
 *   TAMA_EVAL_KEY=sk-... \
 *   TAMA_EVAL_BASE_URL=https://openrouter.ai/api/v1 \
 *   bun test test/eval
 *
 * Not in CI. It costs a few cents a run and would fail on a rate limit rather
 * than on a regression, which is a worse signal than not running.
 */
const MODEL = process.env.TAMA_EVAL_MODEL;
const KEY = process.env.TAMA_EVAL_KEY;
const BASE_URL = process.env.TAMA_EVAL_BASE_URL;

const VAULT = new URL("../fixtures/vault", import.meta.url).pathname;
const retriever = new GrepRetriever(VAULT);

const config = (): LlmConfig =>
  BASE_URL
    ? { provider: "openai-compatible", baseUrl: BASE_URL, apiKey: KEY, model: MODEL! }
    : { provider: "anthropic", apiKey: KEY, model: MODEL! };

describe.skipIf(!MODEL || !KEY)("answers, against a real model", () => {
  const run = (question: string) =>
    askOnce({ question, retriever, llm: makeLlm(config()), maxChunks: 8 });

  /**
   * Citation accuracy. Every path in the answer has to be a path the model was
   * shown, because a fabricated filename is a fabricated source.
   */
  for (const c of ANSWERABLE) {
    test(`cites only what it was shown: ${c.id}`, async () => {
      const { answer, sources } = await run(c.q);
      expect(unsupportedCitations(answer, sources.map((s) => s.path))).toEqual([]);
    }, 60_000);
  }

  /**
   * Faithfulness, in the cheap approximation: the answer contains the specific
   * the note contains. Not a judge, so it cannot catch a wrong answer that
   * happens to include the right number, but it does catch the common failure
   * of answering around the question with the note in hand.
   */
  for (const c of ANSWERABLE.filter((c) => c.gist)) {
    test(`says the specific: ${c.id}`, async () => {
      const { answer } = await run(c.q);
      const lower = answer.toLowerCase();
      const missing = c.gist!.filter((g) => !lower.includes(g.toLowerCase()));
      expect(missing).toEqual([]);
    }, 60_000);
  }

  /**
   * Refusal correctness. This is the one the whole product rests on: a second
   * brain that invents a memory is worse than no second brain, because you
   * cannot tell which memories are yours.
   */
  for (const c of UNANSWERABLE) {
    test(`refuses: ${c.id}`, async () => {
      const { answer } = await run(c.q);
      // Nothing supports the answer, so nothing may be cited in support of it.
      expect(citedPaths(answer)).toEqual([]);
      if (c.fabricationTell) expect(answer).not.toMatch(c.fabricationTell);
    }, 60_000);
  }
});
