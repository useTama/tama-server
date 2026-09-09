/**
 * Which model an eval check gets, and how many times it has to generate.
 *
 * Kept out of `metrics.ts` deliberately: that file is nothing but string
 * predicates over an answer, and it stays that way so a metric can never
 * quietly acquire a model.
 *
 * ## Two gates, not one
 *
 * The answer eval used to be a single `skipIf(!MODEL || !KEY)`, which lumped
 * together two different kinds of check (#61):
 *
 * - **Whether a citation was invented** is a string predicate. It needs *a*
 *   model to produce an answer, not a good or an expensive one. A path that
 *   was not in the context was constructed, and a model willing to construct a
 *   filename will construct the fact underneath it - which is the sharpest
 *   cheap signal there is, and it was locked behind a paid key.
 * - **Whether an answer is faithful** needs a good model, because a weak one
 *   produces thin answers on its own weakness rather than on any regression.
 *   A red build nobody believes is worse than no build.
 *
 * So the judge-free checks take whatever model is available, preferring a free
 * local one, and the faithfulness checks still require the paid gate.
 */

import { askOnce } from "../../src/ask.ts";
import { GrepRetriever } from "../../src/retrieval.ts";
import { makeLlm, type Llm, type LlmConfig } from "../../src/llm.ts";

const VAULT = new URL("../fixtures/vault", import.meta.url).pathname;

/**
 * A model good enough to judge an answer by. Costs money, so it stays opt-in.
 *
 *   TAMA_EVAL_MODEL=anthropic/claude-sonnet-5 TAMA_EVAL_KEY=sk-... bun run eval
 */
export function paidLlm(): Llm | undefined {
  const model = process.env.TAMA_EVAL_MODEL;
  const key = process.env.TAMA_EVAL_KEY;
  if (!model || !key) return undefined;
  const baseUrl = process.env.TAMA_EVAL_BASE_URL;
  const config: LlmConfig = baseUrl
    ? { provider: "openai-compatible", baseUrl, apiKey: key, model }
    : { provider: "anthropic", apiKey: key, model };
  return makeLlm(config);
}

/**
 * Any model at all, for the checks that only need words on a page.
 *
 *   TAMA_EVAL_LOCAL_MODEL=qwen2.5:0.5b-instruct bun run eval
 *
 * Gated on the model tag alone and never on a key: `OpenAiCompatibleLlm` sends
 * no Authorization header when there is no key, which is what makes Ollama,
 * llama.cpp and LM Studio work with nothing configured but a URL.
 *
 * `maxTokens` is deliberately low. On a CPU model every allowed token is
 * wall-clock seconds, and a half-billion-parameter model will ramble well past
 * the answer if you let it.
 */
export function judgeFreeLlm(): Llm | undefined {
  const model = process.env.TAMA_EVAL_LOCAL_MODEL;
  if (model) {
    return makeLlm({
      provider: "openai-compatible",
      baseUrl: process.env.TAMA_EVAL_LOCAL_URL ?? "http://127.0.0.1:11434/v1",
      model,
      maxTokens: 512,
    });
  }
  // No local model configured, but a paid one might be. The judge-free checks
  // are happy with it; they were only ever gated on it by accident.
  return paidLlm();
}

/**
 * One generation per question, however many checks read it.
 *
 * The two loops over ANSWERABLE used to ask the same questions twice, which on
 * a paid model is double the money and on a CPU model is double a wall-clock
 * cost measured in minutes. Keyed by model name as well as question, so a run
 * with both a local and a paid model does not serve one's answer to the
 * other's assertions.
 */
export function answerer(llm: Llm) {
  const retriever = new GrepRetriever(VAULT);
  const cache = new Map<
    string,
    Promise<{ answer: string; sources: Array<{ path: string; score: number }> }>
  >();
  return (question: string) => {
    const key = `${llm.name} ${question}`;
    let pending = cache.get(key);
    if (!pending) {
      pending = askOnce({ question, retriever, llm, maxChunks: 8 }).then((r) => ({
        answer: r.answer,
        sources: r.sources,
      }));
      cache.set(key, pending);
    }
    return pending;
  };
}
