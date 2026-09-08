/**
 * Take our own @mention out of a question before the model reads it.
 *
 * WhatsApp renders a mention as the contact's name but sends it as the raw
 * number: "@Tama hello" arrives as "@918088775227 hello". The server's prompt
 * separately states that number as its own address, so the model was handed
 * "@<my own number> hello" and read it as the owner greeting themselves - which
 * is exactly what it answered, four times in a row.
 *
 * The mention is how you address it in a group, so it is not information: by
 * the time this runs the message has already been recognised as addressed to
 * us. Removed after that check, never before, because the number appearing in
 * the body is one of the things that check relies on.
 */

/**
 * @param {string} text the message body
 * @param {Iterable<string>} ourDigits every digit string that identifies us
 * @returns {string} the body without our mention, or unchanged if that empties it
 */
export function stripOurMention(text, ourDigits) {
  let out = text ?? "";
  for (const raw of ourDigits ?? []) {
    const digits = String(raw ?? "").replace(/\D/g, "");
    if (!digits) continue;
    // A trailing digit boundary, so @91808877522 does not match inside
    // @918088775227 and leave a stray "7" in the question.
    out = out.replace(new RegExp(`@${digits}(?!\\d)`, "g"), " ");
  }
  out = out.replace(/\s+/g, " ").trim();
  // A bare mention is the whole message. There is nothing to strip it down to,
  // and sending an empty question would be worse than sending the number.
  return out || (text ?? "").trim();
}
