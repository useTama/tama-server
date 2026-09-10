/**
 * What has to be true of an answer before it is sent.
 *
 * Everything here runs on the finished text, not on the prompt. The prompt is
 * where a rule is *asked for*; this is where the ones that must not be
 * negotiable are *held*. `stripEmDashes` in ask.ts was the first of these and
 * states the principle: an absolute rule should not depend on the model
 * choosing to follow it.
 *
 * One rule qualified so far. It was already written down in `GROUND_RULES`, it
 * was broken in a real WhatsApp session, and it fails silently.
 *
 * **A citation names a note the model was shown.** `CITE_RULES` asks for a path
 * beside every claim and explains why: an uncited fact reads as invented. The
 * inverse was never handled, and it is worse. A cited path reads as verified,
 * so the citation format is the thing that makes a fabricated claim credible.
 * Of the distinct paths cited across that session, three did not exist, and two
 * of the three were attached to claims that were themselves false.
 *
 * The citation half of this used to live in `test/eval/metrics.ts` and ran only
 * under a gated eval. The detector and the guard are now the same code, because
 * two copies of "what counts as a citation" drift until the graded one and the
 * enforced one disagree, and then the eval is measuring something the server
 * does not do.
 */

/**
 * A path as it appears in an answer.
 *
 * Deliberately loose about the leading folders, which is the property the eval
 * relied on: a model that cites `latency-investigation.md` without its folder
 * has still cited the right note, and grading that as a miss would measure
 * formatting instead of grounding.
 *
 * Deliberately NOT loose about spaces, which the first version of this was. Its
 * character class included a literal space, so "as you wrote in Work/notes.md"
 * matched *from the "a" of "as"* and yielded the citation
 * `as you wrote in Work/notes.md`. Under an eval that only over-reports a
 * failure; under a guard that rewrites text it would delete most of a sentence.
 * The old behaviour was never visible because `CITE_RULES` asks for a path in
 * parentheses and "(" is not a word character, so the run always started inside
 * the bracket.
 */
const PATH_SOURCE = String.raw`(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md`;

/** Paths the answer cites. */
export function citedPaths(answer: string): string[] {
  return [...new Set(Array.from(answer.matchAll(new RegExp(PATH_SOURCE, "g")), (m) => m[0]))];
}

/**
 * Citations that name a note the model was never shown.
 *
 * This is the sharpest cheap signal there is. A path in the context can be
 * copied; a path that is not in the context was constructed, and a model
 * willing to construct a filename is willing to construct the fact under it.
 */
export function unsupportedCitations(answer: string, allowed: string[]): string[] {
  return citedPaths(answer).filter(
    (cited) => !allowed.some((a) => a === cited || a.endsWith(`/${cited}`)),
  );
}

/**
 * A parenthesised group, so a citation can be told from prose in brackets.
 *
 * `[^()]*` rather than anything recursive: a nested bracket means this is not
 * the citation format `CITE_RULES` asked for, and the fallback pass below
 * handles a stray path wherever it turns up.
 */
const CITATION_GROUP = /([ \t]*)\(([^()]*)\)/g;

/** What may sit between two paths in one citation group and still be one. */
const SEPARATORS = /[\s,;]+|\band\b|\bcaptured\b|[\d:+-]|T\d/g;

/**
 * Remove citations the model was not entitled to, and keep the sentence.
 *
 * Stripping the path rather than dropping the sentence is the deliberate
 * choice. The claim may be sound and the path mis-remembered, and deleting a
 * true statement to punish a bad citation trades one silent error for another.
 * What the reader loses is a source they could not have opened anyway; what
 * they gain is that every path still on screen is real.
 *
 * Two passes, because the parenthesised form is the one that was asked for and
 * the one that carries the false authority:
 *
 *   1. a group that is nothing but paths and separators. Unsupported paths come
 *      out of it, and if that empties the group the brackets go too, along with
 *      the space in front of them so no sentence ends "on tags ."
 *   2. anything left, cited bare mid-sentence. The path is removed and the
 *      whitespace tidied.
 *
 * Never touches a supported path, so an answer with nothing wrong in it comes
 * back byte-identical.
 */
export function stripUnsupportedCitations(
  answer: string,
  allowed: string[],
): { answer: string; stripped: string[] } {
  const bad = new Set(unsupportedCitations(answer, allowed));
  if (bad.size === 0) return { answer, stripped: [] };

  const path = new RegExp(PATH_SOURCE, "g");

  let out = answer.replace(CITATION_GROUP, (whole, lead: string, inner: string) => {
    const found = inner.match(path) ?? [];
    if (found.length === 0) return whole;
    // Prose that happens to contain a path is not a citation group, and
    // rewriting it would eat words. Left for the second pass.
    if (inner.replace(new RegExp(PATH_SOURCE, "g"), "").replace(SEPARATORS, "") !== "") return whole;

    const kept = found.filter((p) => !bad.has(p));
    if (kept.length === found.length) return whole;
    return kept.length === 0 ? "" : `${lead}(${kept.join(", ")})`;
  });

  out = out.replace(new RegExp(PATH_SOURCE, "g"), (m) => (bad.has(m) ? "" : m));

  // Tidy what removal left behind. Spaces and tabs only: collapsing newlines
  // would reflow an answer that deliberately used them.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();

  return { answer: out, stripped: [...bad] };
}
