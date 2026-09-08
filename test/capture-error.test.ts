import { expect, test } from "bun:test";
import { CaptureError, sttStatusFor } from "../src/capture-error.ts";
import { toWav16k } from "../src/audio.ts";
import { Stt } from "../src/stt.ts";

test("the fix is part of what the client is shown, not only the fault", () => {
  // The message is the whole diagnostic on this path: a self-hoster hitting it
  // has no vendor to ask.
  const e = new CaptureError(503, "stt", "speech to text is unreachable", "is whisper-server running?");
  expect(e.detail).toBe("speech to text is unreachable. is whisper-server running?");
  expect(new CaptureError(500, "vault", "disk full").detail).toBe("disk full");
});

test("a provider outage is retriable and a rejected key is not", () => {
  // Retrying a 401 spends the same rejection three times and delays the reply
  // that would have told someone to fix the key.
  expect(sttStatusFor(500)).toBe(503);
  expect(sttStatusFor(502)).toBe(503);
  expect(sttStatusFor(401)).toBe(502);
  expect(sttStatusFor(404)).toBe(502);
});

test("undecodable audio is 415, because resending it changes nothing", async () => {
  // Real ffmpeg, real garbage. Skipped rather than failed where ffmpeg is
  // absent, since that is a valid state for a text-only install.
  if (!Bun.which("ffmpeg")) return;
  const notAudio = new Uint8Array(2048).fill(0x7a);
  try {
    await toWav16k(notAudio);
    throw new Error("expected a CaptureError");
  } catch (e) {
    expect(e).toBeInstanceOf(CaptureError);
    const err = e as CaptureError;
    expect(err.status).toBe(415);
    expect(err.stage).toBe("audio");
    // ffmpeg's own stderr is relayed: it is the only thing that names the
    // container or codec it choked on.
    expect(err.detail.length).toBeGreaterThan(20);
  }
});

test("an unreachable whisper is 503 and names the endpoint it tried", async () => {
  // Port 1 refuses immediately, so this needs no fixture server.
  const stt = new Stt({ provider: "whisper-cpp", url: "http://127.0.0.1:1" });
  try {
    await stt.transcribe(new Uint8Array(64));
    throw new Error("expected a CaptureError");
  } catch (e) {
    expect(e).toBeInstanceOf(CaptureError);
    const err = e as CaptureError;
    expect(err.status).toBe(503);
    expect(err.stage).toBe("stt");
    // The url is the thing most likely to be wrong, so it goes in the message.
    expect(err.detail).toContain("http://127.0.0.1:1/inference");
    expect(err.detail).toContain("whisper-server");
  }
});
