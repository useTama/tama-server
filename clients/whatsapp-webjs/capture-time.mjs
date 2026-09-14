/**
 * When the owner decided to keep this, as a header the server will accept.
 *
 * `new Date(undefined * 1000).toISOString()` throws RangeError, and both
 * capture paths built that header straight from `message.timestamp` - a field
 * supplied by whatsapp-web.js, not by us. A voice note whose timestamp did not
 * arrive would throw after the audio had already been downloaded, losing the
 * note to report an error about the clock.
 *
 * Returning undefined instead is safe because the header is optional:
 * resolveCaptureTime falls back to the server clock and records the basis as
 * "server-clock" in the journal, so the cost is a few seconds of precision on
 * a note that would otherwise not exist.
 *
 * For a forward this is when it landed in the chat, which is the right answer -
 * the capture happened when the owner passed it on, not when it was written.
 */
export function capturedAtHeader(message) {
  const seconds = Number(message?.timestamp);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const at = new Date(seconds * 1000);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}
