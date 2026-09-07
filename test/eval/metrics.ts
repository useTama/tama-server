/**
 * The judge-free metrics.
 *
 * Three of the four things worth measuring about an answer need no model to
 * check: whether the right note was retrieved, whether the citations resolve
 * to notes that were actually in the context, and whether an unanswerable
 * question produced an invented specific. Only faithfulness needs a judge,
 * and a judge brings length bias, positional bias and self-preference, so it
 * stays out until these three are boring.
 */

/**
 * Paths the answer cites.
 *
 * CITE_RULES asks for a bare path in parentheses, so this reads parentheses
 * rather than any markdown link syntax. Deliberately loose about the leading
 * folders: a model that cites `latency-investigation.md` without its folder
 * has still cited the right note, and grading that as a miss would measure
 * formatting instead of grounding.
 */
export function citedPaths(answer: string): string[] {
  const found = new Set<string>();
  for (const m of answer.matchAll(/([A-Za-z0-9][A-Za-z0-9 _\-./]*\.md)/g)) {
    found.add(m[1]!.trim());
  }
  return [...found];
}

/**
 * Citations that name a note the model was never shown.
 *
 * This is the sharpest cheap signal there is. A path in the context can be
 * copied; a path that is not in the context was constructed, and a model
 * willing to construct a filename is willing to construct the fact under it.
 */
export function unsupportedCitations(answer: string, retrieved: string[]): string[] {
  return citedPaths(answer).filter(
    (cited) => !retrieved.some((r) => r === cited || r.endsWith(`/${cited}`)),
  );
}
