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

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BYTES_PER_SAMPLE = 2;
/** Canonical PCM WAV: RIFF, one `fmt ` chunk, one `data` chunk, no metadata. */
export const WAV_HEADER_BYTES = 44;

export async function toWav16k(input: Uint8Array, maxSeconds = 300): Promise<Uint8Array> {
  let proc;
  try {
    proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner", "-loglevel", "error",
        "-i", "pipe:0",
        "-t", String(maxSeconds),
        "-ac", String(CHANNELS),
        "-ar", String(SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        // Raw samples, not a wav container. See wavFromPcm: the wav muxer
        // cannot write correct chunk sizes into a pipe, and one provider
        // believes them.
        "-f", "s16le",
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
  return wavFromPcm(new Uint8Array(out));
}

/**
 * Wrap raw 16 kHz mono s16 samples in a wav header that states their real size.
 *
 * ffmpeg's wav muxer writes placeholder sizes and patches them on close by
 * seeking back to the header. A pipe cannot seek, so both the RIFF size and the
 * `data` size stay 0xFFFFFFFF. ffmpeg, ffprobe and whisper.cpp all shrug and
 * believe the byte count instead, so this was invisible for as long as those
 * were the only readers. Sarvam believes the header, and 0xFFFFFFFF bytes of
 * this format is 37 hours, so a two second voice note came back as "Audio
 * duration exceeds the maximum limit of 30 seconds".
 *
 * Building the header here is also what makes `wavSeconds` exact: the muxer
 * inserted a `LIST`/`INFO` chunk naming the Lavf version, which the fixed
 * 44-byte assumption below counted as audio.
 */
function wavFromPcm(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  const h = new DataView(wav.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) wav[at + i] = s.charCodeAt(i);
  };
  const blockAlign = CHANNELS * BYTES_PER_SAMPLE;
  ascii(0, "RIFF");
  h.setUint32(4, 36 + pcm.byteLength, true); // everything after this field
  ascii(8, "WAVEfmt ");
  h.setUint32(16, 16, true); // fmt chunk length
  h.setUint16(20, 1, true); // 1 is uncompressed PCM
  h.setUint16(22, CHANNELS, true);
  h.setUint32(24, SAMPLE_RATE, true);
  h.setUint32(28, SAMPLE_RATE * blockAlign, true); // byte rate
  h.setUint16(32, blockAlign, true);
  h.setUint16(34, 8 * BYTES_PER_SAMPLE, true);
  ascii(36, "data");
  h.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, WAV_HEADER_BYTES);
  return wav;
}

/** Seconds of audio in a 16 kHz mono s16 WAV, from the byte count. */
export function wavSeconds(wav: Uint8Array): number {
  return Math.max(0, (wav.byteLength - WAV_HEADER_BYTES) / (SAMPLE_RATE * BYTES_PER_SAMPLE));
}
