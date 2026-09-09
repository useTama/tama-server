import { expect, test } from "bun:test";
import { splitWav, toWav16k, wavSeconds, WAV_HEADER_BYTES } from "../src/audio.ts";

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

test("a long recording is cut into pieces the provider will take", async () => {
  // Sarvam's real-time route refuses anything over thirty seconds and points at
  // its batch API, which would make capture asynchronous.
  if (!Bun.which("ffmpeg")) return;
  const wav = await toWav16k(await oggOpus(10));
  const pieces = splitWav(wav, 3);

  expect(pieces.length).toBeGreaterThan(3);
  for (const p of pieces) expect(wavSeconds(p)).toBeLessThanOrEqual(3);
  // Nothing is lost and nothing is duplicated: the pieces are the recording.
  const total = pieces.reduce((n, p) => n + wavSeconds(p), 0);
  expect(total).toBeCloseTo(wavSeconds(wav), 3);

  // Each piece is a wav a provider can parse, header sizes and all.
  for (const p of pieces) {
    const h = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(h.getUint32(4, true)).toBe(p.byteLength - 8);
    expect(h.getUint32(40, true)).toBe(p.byteLength - WAV_HEADER_BYTES);
    expect(h.getUint32(24, true)).toBe(16000);
  }
});

test("audio inside the limit is handed over untouched", async () => {
  if (!Bun.which("ffmpeg")) return;
  const wav = await toWav16k(await oggOpus(2));
  const pieces = splitWav(wav, 28);
  expect(pieces).toHaveLength(1);
  expect(pieces[0]).toBe(wav);
});

test("the cut lands in the silence, not mid-word", () => {
  // A fixed cut falls mid-word about as often as not, and the two halves come
  // back as two wrong words rather than one right one.
  const seconds = 5;
  const samples = 16000 * seconds;
  const pcm = new Int16Array(samples);
  // Loud everywhere except one 100 ms gap at 2.5s, which is where a cut
  // targeted at 3s should walk back to.
  for (let i = 0; i < samples; i++) pcm[i] = 8000;
  const gapStart = Math.floor(2.5 * 16000);
  const gapEnd = gapStart + Math.floor(0.1 * 16000);
  for (let i = gapStart; i < gapEnd; i++) pcm[i] = 0;

  const wav = new Uint8Array(WAV_HEADER_BYTES + pcm.byteLength);
  wav.set(new Uint8Array(pcm.buffer), WAV_HEADER_BYTES);
  const pieces = splitWav(wav, 3, { searchSeconds: 1 });

  // First piece ends inside the gap, not at the 3s mark.
  const firstEnd = wavSeconds(pieces[0]!);
  expect(firstEnd).toBeGreaterThan(2.5);
  expect(firstEnd).toBeLessThan(2.62);
});
