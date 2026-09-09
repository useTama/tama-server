import { test, expect, afterEach } from "bun:test";
import { Stt, stripNonSpeech, SARVAM_DEFAULT_MODEL } from "../src/stt.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Captures the one request the adapter makes, and answers it. */
function intercept(body: unknown, contentType = "application/json") {
  const seen: { url?: string; headers?: Headers; form?: FormData } = {};
  globalThis.fetch = (async (input: any, init: any) => {
    seen.url = String(input);
    seen.headers = new Headers(init?.headers);
    seen.form = init?.body as FormData;
    return new Response(JSON.stringify(body), { headers: { "content-type": contentType } });
  }) as typeof fetch;
  return seen;
}

const audio = new Uint8Array([1, 2, 3, 4]);

test("sarvam posts to its own route with its own auth header", async () => {
  const seen = intercept({ transcript: "मुझे यह याद रखना है", language_code: "hi-IN" });
  const text = await new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "sk-test" }).transcribe(audio);

  expect(seen.url).toBe("https://api.sarvam.ai/speech-to-text");
  // Bearer would 401 here in a way that reads like a bad key, not a wrong protocol.
  expect(seen.headers?.get("api-subscription-key")).toBe("sk-test");
  expect(seen.headers?.get("authorization")).toBeNull();
  // `transcript`, not `text` — the whole reason this is a separate adapter.
  expect(text).toBe("मुझे यह याद रखना है");
});

test("sarvam defaults the model and auto-detects the language", async () => {
  const seen = intercept({ transcript: "hello" });
  await new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "k" }).transcribe(audio);

  expect(seen.form?.get("model")).toBe(SARVAM_DEFAULT_MODEL);
  expect(seen.form?.get("language_code")).toBe("unknown");
  // response_format is an OpenAI field; sending it to Sarvam is noise.
  expect(seen.form?.get("response_format")).toBeNull();
});

test("a configured sarvam language is sent as the hint", async () => {
  const seen = intercept({ transcript: "hello" });
  await new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "k", model: "saaras:v4", language: "hi-IN" }).transcribe(audio);

  expect(seen.form?.get("model")).toBe("saaras:v4");
  expect(seen.form?.get("language_code")).toBe("hi-IN");
});

test("the openai shape keeps Bearer, its own route, and `text`", async () => {
  const seen = intercept({ text: "the older wire format" });
  const text = await new Stt({ provider: "openai-compatible", url: "https://api.groq.com/openai/v1", model: "whisper-large-v3", apiKey: "gsk" }).transcribe(audio);

  expect(seen.url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
  expect(seen.headers?.get("authorization")).toBe("Bearer gsk");
  expect(seen.form?.get("model")).toBe("whisper-large-v3");
  expect(text).toBe("the older wire format");
});

test("whisper.cpp posts to /inference and names no model", async () => {
  const seen = intercept({ text: "local and free" });
  await new Stt({ provider: "whisper-cpp", url: "http://127.0.0.1:8081" }).transcribe(audio);

  expect(seen.url).toBe("http://127.0.0.1:8081/inference");
  expect(seen.form?.get("temperature")).toBe("0");
  expect(seen.form?.get("model")).toBeNull();
});

test("sarvam health probes its root, not a listing route it does not serve", async () => {
  const seen = intercept({});
  await new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "k" }).health();
  expect(seen.url).toBe("https://api.sarvam.ai/");

  const openai = intercept({});
  await new Stt({ provider: "openai-compatible", url: "https://api.groq.com/openai/v1", model: "m" }).health();
  expect(openai.url).toBe("https://api.groq.com/openai/v1/models");
});

test("a silent capture is silence whichever provider transcribed it", () => {
  expect(stripNonSpeech("[BLANK_AUDIO]")).toBe("");
  expect(stripNonSpeech("(silence)")).toBe("");
  expect(stripNonSpeech("[MUSIC] the actual thought")).toBe("[MUSIC] the actual thought");
});

/** A wav of `seconds` of tone, built here so the test needs no ffmpeg. */
function tone(seconds: number): Uint8Array {
  const samples = 16000 * seconds;
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) pcm[i] = Math.round(6000 * Math.sin(i / 12));
  const wav = new Uint8Array(44 + pcm.byteLength);
  const h = new DataView(wav.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < s.length; i++) wav[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); h.setUint32(4, 36 + pcm.byteLength, true); ascii(8, "WAVEfmt ");
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, 16000, true); h.setUint32(28, 32000, true);
  h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  ascii(36, "data"); h.setUint32(40, pcm.byteLength, true);
  wav.set(new Uint8Array(pcm.buffer), 44);
  return wav;
}

/** Answers each request in turn, and records what it was sent. */
function interceptMany(...bodies: unknown[]) {
  const calls: { seconds: number }[] = [];
  let i = 0;
  globalThis.fetch = (async (_input: any, init: any) => {
    const form = init?.body as FormData;
    const file = form.get("file") as Blob;
    calls.push({ seconds: (file.size - 44) / 32000 });
    return new Response(JSON.stringify(bodies[i++] ?? {}), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("a recording past sarvam's limit is sent in pieces, joined in order", async () => {
  // Sarvam refuses over thirty seconds and points at its batch API, which is
  // asynchronous - and "your note will appear at some point" is a different
  // product. So the audio is split instead.
  const calls = interceptMany(
    { transcript: "pehla hissa" },
    { transcript: "doosra hissa" },
    { transcript: "teesra hissa" },
  );
  const text = await new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "k" })
    .transcribe(tone(70));

  expect(calls).toHaveLength(3);
  for (const c of calls) expect(c.seconds).toBeLessThanOrEqual(28);
  // In order. Out of order it is not a transcript, it is the same words shuffled.
  expect(text).toBe("pehla hissa doosra hissa teesra hissa");
});

test("a recording inside the limit is still one request", async () => {
  const calls = interceptMany({ transcript: "chhota note" });
  const text = await new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "k" })
    .transcribe(tone(10));
  expect(calls).toHaveLength(1);
  expect(text).toBe("chhota note");
});

test("one piece failing fails the capture, rather than saving half a thought", async () => {
  // Half a transcript saved as a note is worse than no note: it looks like it
  // worked, and nobody re-records what they think they already said.
  let i = 0;
  globalThis.fetch = (async (_input: any, _init: any) => {
    i++;
    return i === 2
      ? new Response("rate limited", { status: 429 })
      : new Response(JSON.stringify({ transcript: "ok" }), { headers: { "content-type": "application/json" } });
    // Through `unknown`: Bun's fetch type carries `preconnect`, which a stub
    // that only answers requests has no reason to implement.
  }) as unknown as typeof fetch;

  await expect(
    new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "k" }).transcribe(tone(70)),
  ).rejects.toThrow(/refused the recording: 429/);
});

test("silence in one piece is a gap, not a failure", async () => {
  const calls = interceptMany(
    { transcript: "shuru mein" },
    { transcript: "[BLANK_AUDIO]" },
    { transcript: "aur aakhir mein" },
  );
  const text = await new Stt({ provider: "sarvam", url: "https://api.sarvam.ai", apiKey: "k" })
    .transcribe(tone(70));
  expect(calls).toHaveLength(3);
  expect(text).toBe("shuru mein aur aakhir mein");
});

test("a provider with no stated limit is sent the whole recording", async () => {
  // whisper.cpp runs locally and has no request cap worth enforcing here.
  const calls = interceptMany({ text: "the whole thing" });
  await new Stt({ provider: "whisper-cpp", url: "http://127.0.0.1:8081" }).transcribe(tone(120));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.seconds).toBeCloseTo(120, 1);
});
