import { expect, test } from "bun:test";
import { toWav16k, wavSeconds, WAV_HEADER_BYTES } from "../src/audio.ts";

/** A real opus voice note, which is what whatsapp delivers, made by ffmpeg. */
async function oggOpus(seconds: number): Promise<Uint8Array> {
  const proc = Bun.spawn(
    [
      "ffmpeg", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
      "-ac", "1", "-c:a", "libopus", "-f", "ogg", "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`fixture encode failed: ${err}`);
  return new Uint8Array(out);
}

test("the wav header states the real size, not a placeholder", async () => {
  // The bug this guards: ffmpeg's wav muxer patches the RIFF and data sizes by
  // seeking back on close, a pipe cannot seek, so both stayed 0xFFFFFFFF.
  // whisper.cpp believes the byte count and never noticed; Sarvam believes the
  // header and rejected a two second note as longer than thirty seconds.
  if (!Bun.which("ffmpeg")) return;
  const wav = await toWav16k(await oggOpus(2));
  const h = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

  expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
  expect(new TextDecoder().decode(wav.subarray(8, 12))).toBe("WAVE");
  expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe("data");
  expect(h.getUint32(4, true)).toBe(wav.byteLength - 8);
  expect(h.getUint32(40, true)).toBe(wav.byteLength - WAV_HEADER_BYTES);

  // 16 kHz, mono, s16 — the format whisper is started with, and the one
  // wavSeconds does its arithmetic in.
  expect(h.getUint16(20, true)).toBe(1);
  expect(h.getUint16(22, true)).toBe(1);
  expect(h.getUint32(24, true)).toBe(16000);
  expect(h.getUint16(34, true)).toBe(16);
});

test("a duration read from the header matches the one we report", async () => {
  // Two ways of measuring the same audio: the header a provider parses, and the
  // number the capture log and the device confirmation show. They diverged
  // before, by the length of the metadata chunk ffmpeg inserted.
  if (!Bun.which("ffmpeg")) return;
  const wav = await toWav16k(await oggOpus(2));
  const declared = new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(40, true);
  expect(declared / (16000 * 2)).toBeCloseTo(wavSeconds(wav), 6);
  expect(wavSeconds(wav)).toBeCloseTo(2, 1);
});

test("the duration cap is enforced on the samples, not just claimed", async () => {
  // maxSeconds is what stops a long recording becoming a long bill, so the
  // trimmed length has to show up in the bytes.
  if (!Bun.which("ffmpeg")) return;
  const wav = await toWav16k(await oggOpus(4), 1);
  expect(wavSeconds(wav)).toBeLessThan(1.2);
});
