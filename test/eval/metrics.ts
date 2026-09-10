/**
 * The judge-free metrics.
 *
 * Three of the four things worth measuring about an answer need no model to
 * check: whether the right note was retrieved, whether the citations resolve
 * to notes that were actually in the context, and whether an unanswerable
 * question produced an invented specific. Only faithfulness needs a judge,
 * and a judge brings length bias, positional bias and self-preference, so it
 * stays out until these three are boring.
 *
 * The citation pair below now lives in `src/guard.ts`, because the server
 * enforces it at runtime rather than only grading it here (#84). Re-exported
 * rather than reimplemented: two copies of "what counts as a citation" drift
 * until the graded one and the enforced one disagree, and at that point this
 * file is measuring something the server does not do.
 */

export { citedPaths, unsupportedCitations } from "../../src/guard.ts";
