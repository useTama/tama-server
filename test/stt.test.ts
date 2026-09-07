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
