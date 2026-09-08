/**
 * Turning "that was wrong" into something the server can record.
 *
 * The signal the owner already produces is a reaction: a thumbs-down on a
 * reply costs one tap, arrives in the same event stream as everything else,
 * and was being dropped on the floor. That is what #60 asked for.
 *
 * A typed command exists beside it for one reason: reactions come from
 * `message_reaction`, and whether a given WhatsApp Web build emits it is not
 * something this project can promise. `/tama wrong` rides `message_create`,
 * which the whole bridge already depends on, so the feature works even where
 * the reaction event never fires.
 *
 * Bare words are deliberately not triggers. "wrong" and "right" are ordinary
 * things to type in a conversation - "right, so what about the rent" is a
 * question, not a verdict - and hijacking them would cost an answer every time
 * someone spoke normally. The `/tama` prefix is the existing convention for
 * addressing the bridge rather than talking in the room.
 */

/** Reaction emoji, mapped to a verdict. Anything else is just a reaction. */
const REACTIONS = new Map([
  ["\u{1F44E}", "wrong"], // thumbs down
  ["\u{1F44D}", "right"], // thumbs up
]);

/**
 * A verdict from a reaction, or null.
 *
 * Variation selectors and skin-tone modifiers are stripped, because 👎 and
 * 👎🏽 are the same judgement and a map of every tone would miss the next one.
 */
export function verdictFromReaction(emoji) {
  if (typeof emoji !== "string") return null;
  const bare = emoji.replace(/[\u{FE0F}\u{FE0E}\u{1F3FB}-\u{1F3FF}]/gu, "").trim();
  return REACTIONS.get(bare) ?? null;
}

/**
 * A verdict from `/tama wrong [why]`, or null.
 *
 * The note is optional and is the most useful part when it is there: "answered
 * about a github issue, I meant the 500" is what turns a complaint into a
 * golden case somebody can write.
 */
export function verdictFromCommand(text) {
  const m = /^\/tama\s+(wrong|right)\b[\s:,-]*(.*)$/is.exec(String(text ?? "").trim());
  if (!m) return null;
  const note = (m[2] ?? "").trim();
  return { verdict: m[1].toLowerCase(), ...(note ? { note } : {}) };
}
