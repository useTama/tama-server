/**
 * What has to be true of an answer before it is sent.
 *
 * Everything here runs on the finished text, not on the prompt. The prompt is
 * where a rule is *asked for*; this is where the ones that must not be
 * negotiable are *held*. `stripEmDashes` in ask.ts was the first of these and
 * states the principle: an absolute rule should not depend on the model
 * choosing to follow it.
 *
 * Two rules qualified. Both were already written down in `GROUND_RULES`, both
 * were broken in a single real WhatsApp session, and both fail silently.
 *
 * **A citation names a note the model was shown.** `CITE_RULES` asks for a path
 * beside every claim and explains why: an uncited fact reads as invented. The
 * inverse was never handled, and it is worse. A cited path reads as verified,
 * so the citation format is the thing that makes a fabricated claim credible.
 * Of the distinct paths cited across that session, three did not exist, and two
 * of the three were attached to claims that were themselves false.
 *
 * **The ask path cannot write.** See `claimedWrite` below.
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
    .replace(/\(\s*\)/g, "")
    // An opening bracket the model never closed. The group pass needs both to
    // fire, so "see (Bad.md and more" fell through to the second pass and was
    // left as "see ( and more". A space directly after "(" is not something
    // prose does, so this is safe to take.
    .replace(/\((?=[ \t]|$)/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([,.;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim();

  // An answer that was nothing but a fabricated citation strips to nothing, and
  // an empty string is worse than a stripped one: a WhatsApp send is refused
  // for an empty body, and `/ask` would return a successful response with no
  // answer in it. So say the honest thing instead.
  if (!/[\p{L}\p{N}]/u.test(out)) return { answer: NOTHING_SOLID, stripped: [...bad] };

  return { answer: out, stripped: [...bad] };
}

/**
 * What is left when every claim in an answer rested on an invented source.
 *
 * Short, and it does not narrate the machinery: the reader cannot see a
 * citation being removed and does not need to hear about one. No closing full
 * stop, matching `CHAT_RULES`, because this lands in a chat more often than in
 * a terminal.
 */
export const NOTHING_SOLID = "I do not have anything solid on that";

/**
 * Phrases that claim a write the ask path cannot perform.
 *
 * `GROUND_RULES` says it flatly: "This path is read-only. Never claim you
 * edited, organized, filed, posted, sent or published anything, and never imply
 * you will." The rule lost anyway, five times in one session, because the
 * pressure to break it comes from the owner on exactly the requests they care
 * most about. "Add this to the build plan" is not a question, and the socially
 * correct completion is confirmation.
 *
 * The Hinglish entries are not thoroughness, they are the actual failures. The
 * observed claims were "note add kar diya hai", "add kar liya" and "remind kar
 * diya hai"; an English-only matcher would have caught none of them.
 *
 * Scoped to the first person on purpose. "You added it to the list" is a
 * statement about something the owner did, and reporting a note's contents back
 * must keep working.
 */
const WRITE_CLAIMS: RegExp[] = [
  // English, first person, completed.
  /\bi(?:'ve| have)?\s+(?:just\s+)?(?:added|saved|filed|logged|noted|recorded|written|updated|appended|created|set)\b/i,
  /\b(?:added|saved|filed|logged|noted|recorded|appended|updated)\s+(?:it|that|this|them)\s+to\b/i,
  /\b(?:done|added|saved|filed|logged|noted)\s*[,.]?\s*(?:it(?:'s| is)\s+(?:in|on)\b|to\s+your\b)/i,
  // Sentence-initial only, which is the standalone-confirmation form. Matching
  // "reminder set" anywhere caught "your notes say the reminder is set for
  // friday", and reporting what a note says is the thing that must keep
  // working: the guard exists to stop invented actions, not to stop recall.
  /(?:^|[.!?]\s+)reminder set\b/i,
  /\bi(?:'ve| have)?\s+(?:reminded|scheduled)\b/i,
  // Hinglish. "kar diya", "kar liya" and "kar di" are the completed forms.
  /\b(?:add|save|note|file|log|update|remind|likh|daal|dal)\w*\s+kar\s+(?:diya|liya|di|dii)\b/i,
  /\b(?:add|note|likh|daal|dal)\w*\s+(?:diya|liya|di)\s+hai\b/i,
  /\bnote\s+(?:bana|banaa)\s+(?:diya|liya)\b/i,
];

/**
 * Whether an answer claims to have written something.
 *
 * A detector, not a rewriter. What to say instead depends on what was asked,
 * and the caller is the only thing that knows whether a write path exists yet.
 */
export function claimedWrite(answer: string): boolean {
  return WRITE_CLAIMS.some((re) => re.test(answer));
}

/**
 * What to send instead of a claimed write.
 *
 * Said in the plainest available terms, because the whole failure was an answer
 * that sounded like a yes. It names the limit and hands the action back rather
 * than apologising, and it does not promise the feature: a reply that says "not
 * yet" invites the owner to wait for it.
 *
 * Deliberately not a rewrite of the model's text. Editing a confirmation into a
 * refusal means guessing which clause was the lie, and a half-corrected answer
 * is the failure again in a quieter voice.
 */
export const CANNOT_WRITE =
  "I can read your notes but I cannot write to them, so nothing was saved just now. " +
  "Put it in your vault and I will have it next time you ask";
