/**
 * Normalise whatever a client sends (m4a, caf, ogg, mp3, wav at any rate)
 * into the one format whisper wants: 16 kHz, mono, signed 16-bit PCM WAV.
 *
 * ffmpeg is invoked with an argv ARRAY and reads from stdin. No shell string is
 * ever built, so no part of a client upload can become a command.
 */
export async function toWav16k(input: Uint8Array, maxSeconds = 300): Promise<Uint8Array> {
  const proc = Bun.spawn(
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

  proc.stdin.write(input);
  await proc.stdin.end();

  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (code !== 0) throw new Error(`ffmpeg failed (${code}): ${err.slice(0, 300)}`);
  if (out.byteLength < 128) throw new Error("ffmpeg produced no audio. is the upload actually audio?");
  return new Uint8Array(out);
}

/** Seconds of audio in a 16 kHz mono s16 WAV, from the byte count. */
export function wavSeconds(wav: Uint8Array): number {
  return Math.max(0, (wav.byteLength - 44) / (16000 * 2));
}
