/**
 * Telling "keep this" from "answer this", without asking a model.
 *
 * Typed text arriving over WhatsApp was only ever a question. A voice note
 * became a note and everything else became an ask, so a plan somebody
 * forwarded got answered once and then existed nowhere: conversation memory is
 * scoped to one chat, folds into a 120-word paragraph after 30 turns and is
 * deliberately unsearchable, because those are other people's messages and not
 * notes the owner wrote (src/memory.ts). Open a new chat tomorrow and the plan
 * is gone.
 *
 * The obvious fix is to let a model read each message and decide. It is the
 * wrong one here. Capture is the one path that touches no language model,
 * which is what lets it work with no account and no key (src/ask.ts), and a
 * classifier in front of it would mean a flaky provider silently swallowing
 * thoughts - the failure you would notice weeks later, looking for something
 * you were sure you had saved.
 *
 * So both signals are deterministic and both arrive free with the message.
 */

/**
 * A note from `/tama note <text>`.
 *
 * Returns `{ text }` for any `/tama note`, including an empty one, and null
 * for everything else. The empty case matters: falling through to null would
 * hand "/tama note" to the claim handler, which reads the word after `/tama`
 * as an audience name and would quietly claim the chat as one called "note".
 */
export function noteFromCommand(text) {
  const m = /^\/tama\s+note\b[\s:,-]*(.*)$/is.exec(String(text ?? "").trim());
  return m ? { text: (m[1] ?? "").trim() } : null;
}

/**
 * Whether WhatsApp says this message was forwarded.
 *
 * Two fields for the same fact because whatsapp-web.js populates them from
 * different places depending on the web build, the way the serialized message
 * id needed both `_serialized` and `$1`. Reading only `isForwarded` means a
 * build that reports forwards solely as a score captures nothing and gives no
 * sign it is doing so.
 */
export function wasForwarded(message) {
  if (!message || typeof message !== "object") return false;
  if (message.isForwarded === true) return true;
  const score = Number(message.forwardingScore);
  return Number.isFinite(score) && score > 0;
}

/**
 * Question words, which are the only opener English does not share with a
 * statement.
 *
 * The auxiliaries are deliberately not here. "will order the notepad
 * tommorow", "can pick the caps up friday" and "got the totebag sample" are
 * all notes with the subject dropped, which is exactly how this vault's
 * captures read, and an opener list containing `will`, `can` or `got` would
 * send every one of them back to /ask. A wh-word cannot open a dropped-subject
 * statement, so it carries the signal the auxiliaries only look like they
 * carry.
 *
 * Hinglish sits in the same list rather than a second one, because it arrives
 * in the same sentence: `guard.ts` learned that from real messages, where the
 * write claims that slipped through were "add kar diya hai" and not anything
 * an English-only matcher would see.
 */
const WH_WORDS =
  /^(?:what|whats|what's|when|whens|where|wheres|who|whos|who's|whose|whom|why|how|hows|how's|which|kya|kyaa|kab|kahan|kaha|kaun|kon|kaise|kaisa|kaisi|kyun|kyu|kyon|kitna|kitne|kitni|kaunsa|konsa)\b/i;

/**
 * An auxiliary is only interrogative when a subject follows it.
 *
 * This is the narrow readmission of the openers `WH_WORDS` turns away, and the
 * pronoun is what makes it safe: "is it done" and "did i order the caps" are
 * questions, while "is fine for now" and "did order them" are notes. Without
 * the second half this would match the statements too, which is the bug it
 * exists to avoid.
 */
const AUX_QUESTION =
  /^(?:is|are|was|were|am|do|does|did|can|could|should|shall|will|would|have|has|had|may|might)\s+(?:i|it|we|you|u|they|he|she|there|that|this|these|those|my|our|your|his|her|their|the|any|anyone|anything|someone|somebody)\b/i;

/**
 * Imperatives that ask the vault something, as opposed to imperatives that are
 * the task itself.
 *
 * "tell me", "show me" and "give me" all require their pronoun: "tell shivansh
 * about the workshop" and "give the totebag to kiks" are things to do, not
 * things to ask, and the bare verb would have taken both.
 *
 * "remind me" splits on what follows it, and the split is the useful part.
 * "remind me what i said about iict" is a query; "remind me to order the
 * notepad" is the single most note-shaped sentence there is, and routing it to
 * /ask would lose precisely the open loop that `routeOnce` exists to pick up.
 *
 * "list" excludes "list of" for the same reason: "list of things to order" is
 * a note that happens to start with the word.
 *
 * `find` and `search` are absent on purpose. "find the notepad receipt" reads
 * as a task at least as often as a query, and the safe direction here is to
 * keep it.
 */
const ASK_VERBS =
  /^(?:tell\s+me|show\s+me|give\s+me|remind\s+me\s+(?:what|when|where|who|why|how|about|of)\b|explain|describe|summari[sz]e|recap|compare|draft|catch\s+me\s+up|walk\s+me\s+through|list(?!\s+of)\b)/i;

/**
 * Whether a typed line is asking something rather than saying something worth
 * keeping.
 *
 * Every other branch of the bridge reads a signal WhatsApp attached to the
 * message itself: a voice note is audio, a forward is `isForwarded`, a command
 * starts with `/tama`. Plain typed text carries none, so it was the one shape
 * that always reached /ask. "cap and totebag final tommorow" was therefore
 * answered as a query, and because retrieval always returns its best match the
 * reply came back citing a real note, sounding certain, and the thought was
 * never written anywhere. Silent, plausible, and found out weeks later.
 *
 * A shape test on the text, and nothing else. Not a model, for the reason
 * `noteFromCommand` above is not one either: capture is the single path that
 * touches no language model, which is what lets it run with no account and no
 * key, and a classifier in front of it would let a bad afternoon at a provider
 * swallow thoughts.
 *
 * Which way to be wrong is the whole design. Reading a note as a question puts
 * it back exactly where it already was, so that mistake costs nothing new.
 * Reading a question as a note saves it and says "Saved" out loud, so that
 * mistake is on screen the moment it happens and the question is one retyped
 * line away. Everything above therefore fires only on shapes a note does not
 * take, and anything unrecognised is kept.
 */
export function looksLikeQuestion(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  // Asked outright. This is the one rule that needs no guessing, and it is
  // what catches the auxiliary questions the openers below deliberately miss.
  if (t.endsWith("?")) return true;
  return WH_WORDS.test(t) || AUX_QUESTION.test(t) || ASK_VERBS.test(t);
}

/**
 * Acknowledgements, which are neither a question nor a note.
 *
 * Without this every "ok" becomes a file in the Inbox, and the cost is not the
 * disk. `routeOnce` triages each one against a model, `TRIAGE_SYSTEM` tells it
 * to refuse small talk, so it comes back under `minConfidence`, is retried up
 * to `maxTries`, and then files a `route-gave-up` line into the digest. Three
 * model calls and a failure report, for the word "ok".
 *
 * They keep going to /ask, which is what they do today. Answering "thanks" is
 * a bit silly; saving it is worse, and silence is the failure this bridge was
 * built to stop.
 */
const ACKNOWLEDGEMENTS = new Set([
  "ok", "okk", "okay", "k", "kk", "cool", "nice", "great", "perfect", "lovely",
  "thanks", "thank you", "thanku", "thankyou", "ty", "thx", "cheers",
  "yes", "yeah", "yep", "yup", "ya", "no", "nope", "nah", "sure", "right",
  "done", "got it", "gotit", "noted", "understood", "fine",
  "hmm", "hm", "hmmm", "oh", "ah", "lol", "haha", "hahaha",
  "haan", "han", "haa", "hn", "nahi", "nai", "theek", "thik", "thike",
  "accha", "acha", "achha", "sahi", "bas", "arre", "arey",
]);

/**
 * Whether a line is worth putting in the vault at all.
 *
 * Two rejections. An acknowledgement, per the list above. And anything with no
 * letter and no digit in it: a lone 👍 or "!!" is a reaction, and a note whose
 * whole body is punctuation tells a reader nothing six months later. The same
 * `\p{L}\p{N}` test decides "is there anything here" in `guard.ts`, where an
 * answer stripped down to punctuation is treated as no answer.
 */
export function worthKeeping(text) {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (!/[\p{L}\p{N}]/u.test(t)) return false;
  return !ACKNOWLEDGEMENTS.has(t.toLowerCase().replace(/[.!,]+$/, ""));
}
