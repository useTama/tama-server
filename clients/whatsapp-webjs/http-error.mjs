/**
 * The server's own explanation of a failure, kept rather than thrown away.
 *
 * `doCapture` answers a failed capture with `{"error": "<what actually
 * broke>"}` and a 500. It also records the same string in the `failures` table
 * and prints it to stderr, so the server always knows. The phone did not: the
 * retry loop in bridge.mjs replaced the whole response with `new Error("HTTP
 * 500")`, which is how "ffmpeg is not installed" reached a user as
 * "Something went wrong handling that: HTTP 500".
 *
 * That is worse than unhelpful. The capture path is the one thing this project
 * promises works with no account, no key and no model, and a failure in it that
 * names nothing is a failure nobody can act on without shell access to the
 * server. The person holding the phone is usually the person who could fix it.
 */

/** Cap on the relayed text. A stack trace in a group chat helps nobody. */
const MAX_DETAIL = 300;

/**
 * `": <cause>"` if the response carried one, otherwise `""`, so a caller can
 * append it to a status line unconditionally.
 *
 * Best-effort on purpose. This reads a response that is already being
 * discarded, so an empty body, a truncated one, a proxy's HTML error page or a
 * body already consumed must not turn a reportable failure into an
 * unreportable one.
 */
export async function errorDetail(res) {
  let text;
  try {
    text = await res.text();
  } catch {
    return "";
  }
  if (typeof text !== "string" || !text.trim()) return "";

  let message = text.trim();
  try {
    const parsed = JSON.parse(message);
    // Only tama's own shape is unwrapped. Anything else keeps its raw text,
    // since a proxy that answers with JSON is still telling us something.
    if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
      message = parsed.error.trim();
    }
  } catch {
    // Not JSON. An HTML error page from a reverse proxy lands here, and its
    // first line is more use than nothing.
  }

  // Collapsed to one line: a reply is a chat bubble, and a multi-line body
  // arrives as a wall with the useful part somewhere inside it.
  message = message.replace(/\s+/g, " ").trim();
  if (!message) return "";
  return `: ${message.length > MAX_DETAIL ? `${message.slice(0, MAX_DETAIL)}...` : message}`;
}
