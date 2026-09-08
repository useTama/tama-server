/**
 * A capture failure the owner can act on, separated from one they cannot.
 *
 * Everything that threw inside `doCapture` became the same 500. That is honest
 * and nearly useless: whisper being unreachable is an infrastructure fault with
 * an obvious fix, ffmpeg refusing a file is a problem with the upload, and
 * neither is an internal error. A voice note came back as a bare "HTTP 500"
 * (#67) and nothing about the reply said which of the three had happened.
 *
 * This matters more on the capture path than anywhere else. Capture is the one
 * thing that is supposed to work with no account, no key and no model, so a
 * self-hoster hitting it has no vendor to ask and no support channel. The
 * message is the whole diagnostic.
 *
 * The status is chosen for what the caller should DO, which is also what a
 * client's retry policy reads (docs/api.md):
 *
 *   503  transient. whisper is down, still booting, or timed out. Retry.
 *   502  an upstream answered and refused. A wrong API key does not heal, so
 *        retrying only spends the same rejection three times.
 *   415  the upload was not audio ffmpeg could decode. Sending it again will
 *        not change that.
 *   500  genuinely ours. A missing ffmpeg belongs here, and so does a vault
 *        that cannot be written to - a full disk, a read-only mount, an
 *        unwritable directory. All of them are the server being set up wrong
 *        rather than the request being wrong, and none of them heals on a
 *        retry: 503 would send the client back with the same idempotency key
 *        against the same full disk.
 */

export type CaptureStage = "audio" | "stt" | "vault";

export class CaptureError extends Error {
  constructor(
    readonly status: number,
    readonly stage: CaptureStage,
    message: string,
    /** What to do about it. Omitted when there is nothing useful to say. */
    readonly hint?: string,
  ) {
    super(message);
    this.name = "CaptureError";
  }

  /**
   * What the client is shown: the fault, then the fix.
   *
   * One line, because it is read in a chat bubble or a phone notification far
   * more often than in a terminal.
   */
  get detail(): string {
    return this.hint ? `${this.message}. ${this.hint}` : this.message;
  }
}

/**
 * Status for a speech-to-text provider that answered and refused.
 *
 * A 5xx from the provider is its outage and worth retrying; a 4xx is a wrong
 * key, a wrong model or a rejected file, and asking twice more just spends the
 * same rejection again.
 */
export function sttStatusFor(providerStatus: number): number {
  return providerStatus >= 500 ? 503 : 502;
}
