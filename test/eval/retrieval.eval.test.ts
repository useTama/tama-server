import { test, expect } from "bun:test";
import { GrepRetriever } from "../../src/retrieval.ts";
import { ANSWERABLE, UNANSWERABLE } from "./golden.ts";

const VAULT = new URL("../fixtures/vault", import.meta.url).pathname;
const LIMIT = 8;
const retriever = new GrepRetriever(VAULT);

/**
 * The clock the fixture is read against, pinned three days after its newest
 * note.
 *
 * Without this the eval measured a moving target. Recency is a half-life of 90
 * days against `Date.now()`, and the fixture is frozen in early 2025, so every
 * note was already several half-lives old and getting older with every day the
 * suite ran - the weight contributed nothing measurable, no case could
 * constrain it, and the scores this file asserts on drifted quietly with the
 * calendar. Pinning it makes recency a live signal again and makes every
 * number here reproducible next year.
 */
const NOW = Date.parse("2025-02-10T09:00:00+05:30");

const paths = async (q: string) =>
  (await retriever.search(q, LIMIT, undefined, NOW)).map((c) => c.path);

/**
 * Recall@8, case by case.
 *
 * This is the eval that matters and the one that needs no model: if the note
 * holding the answer never reaches the context, no prompt can rescue it, and
 * most bad answers turn out to be this rather than the model. It costs nothing
 * to run, so it runs on every push.
 *
 * Asserted per case rather than as an aggregate percentage. A single number
 * going from 0.95 to 0.92 tells you nothing actionable; a named case failing
 * tells you which question broke.
 */
for (const c of ANSWERABLE) {
  test(`recall: ${c.id} — ${c.q}`, async () => {
    const got = await paths(c.q);
    for (const want of c.find) expect(got).toContain(want);
  });
}

/**
 * Discrimination, where the fixture holds a near-miss.
 *
 * Recall alone is passable by a retriever that returns everything vaguely
 * related, and that retriever gives worse answers: the real note is in the
 * context but so are seven others, and the model picks wrong. These cases
 * have a distractor sharing the question's vocabulary, so ranking first is a
 * claim about scoring rather than about matching.
 */
for (const c of ANSWERABLE.filter((c) => c.top)) {
  const run = c.knownGap ? test.failing : test;
  run(`ranks first: ${c.id} — ${c.q}`, async () => {
    expect((await paths(c.q))[0]).toBe(c.top);
  });
}

/**
 * The refusal precondition.
 *
 * Whether the model says "not in your notes" needs the model, so it lives in
 * the gated run. What can be checked for free is the retrieval side: an
 * unanswerable question must not surface a note that scores like an answer,
 * because a high-scoring irrelevant note is exactly what a model confabulates
 * from.
 *
 * Compared against the answerable cases rather than a fixed threshold. The
 * scores are relative by construction, so a hardcoded floor would need
 * rewriting every time the weights move, and would be asserting the weights
 * rather than the behaviour.
 */
test("unanswerable questions score below answerable ones", async () => {
  const best = async (q: string) => (await retriever.search(q, 1, undefined, NOW))[0]?.score ?? 0;

  const answerable = await Promise.all(ANSWERABLE.map((c) => best(c.q)));
  const median = answerable.slice().sort((a, b) => a - b)[Math.floor(answerable.length / 2)]!;

  const offenders: string[] = [];
  for (const c of UNANSWERABLE) {
    const s = await best(c.q);
    if (s >= median) offenders.push(`${c.id} scored ${s} vs median ${median}`);
  }
  expect(offenders).toEqual([]);
});

test("the fixture vault is the size the golden set assumes", async () => {
  // A note added or renamed silently invalidates every path assertion above.
  // Cheaper to fail here with a count than to debug thirty recall failures.
  // Counted off the filesystem, not through the retriever: three of these
  // notes do not contain the word "the".
  const files = await Array.fromAsync(new Bun.Glob("**/*.md").scan(VAULT));
  expect(files.length).toBe(48);
});
