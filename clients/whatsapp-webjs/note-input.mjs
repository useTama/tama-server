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
