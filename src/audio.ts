/**
 * Normalise whatever a client sends (m4a, caf, ogg, mp3, wav at any rate)
 * into the one format whisper wants: 16 kHz, mono, signed 16-bit PCM WAV.
 *
 * ffmpeg is invoked with an argv ARRAY and reads from stdin. No shell string is
 * ever built, so no part of a client upload can become a command.
 *
 * Failures are `CaptureError`, so the reason and the status survive the trip to
 * whatever is holding the microphone. See capture-error.ts.
 */
import { CaptureError } from "./capture-error.ts";

export async function toWav16k(input: Uint8Array, maxSeconds = 300): Promise<Uint8Array> {
  let proc;
  try {
    proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-t", String(maxSeconds),
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
  } catch (e) {
    // A missing binary surfaced as a raw ENOENT from Bun.spawn, which reached
    // the user as "HTTP 500" and named nothing. Setup only warns when ffmpeg is
    // absent, so this is a state a working install can genuinely be left in,
    // and the fix is one command the owner can run.
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new CaptureError(
        500,
        "audio",
        "ffmpeg is not installed, or not on the server's PATH",
        "install it: brew install ffmpeg, or apt install ffmpeg. Audio capture cannot work without it",
      );
    }
    throw e;
  }

  proc.stdin.write(input);

  // stdin must finish writing CONCURRENTLY with stdout/stderr being read, not
  // before: ffmpeg blocks writing to a full stdout pipe once nothing is
  // draining it yet, which stalls it reading further stdin, which stalls
  // `stdin.end()` from ever resolving. 16 kHz PCM output overflows a typical
  // 64 KB pipe buffer within 1-2 seconds of decoded audio, so this deadlocks
  // on any non-trivial recording, not just large ones.
  const [, out, err, code] = await Promise.all([
    proc.stdin.end(),
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  // 415 rather than 500: ffmpeg ran and rejected the bytes, so this is the
  // upload's problem and resending the same file will not change the answer.
  // Its stderr is the only thing that says which codec or container it choked
  // on, so it is relayed rather than summarised.
  if (code !== 0) {
    throw new CaptureError(
      415,
      "audio",
      `ffmpeg could not decode the upload (exit ${code}): ${err.slice(0, 300).trim()}`,
      "the recording may be truncated, empty, or in a format this ffmpeg build has no decoder for",
    );
  }
  if (out.byteLength < 128) {
    throw new CaptureError(
      415,
      "audio",
      "ffmpeg read the upload but produced no audio",
      "is it actually an audio file?",
    );
  }
  return new Uint8Array(out);
}

/** Seconds of audio in a 16 kHz mono s16 WAV, from the byte count. */
export function wavSeconds(wav: Uint8Array): number {
  return Math.max(0, (wav.byteLength - 44) / (16000 * 2));
}
