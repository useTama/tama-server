/**
 * Speech to text. Three wire formats, one client.
 *
 * `whisper-cpp` is whisper.cpp's bundled HTTP server, held resident. Local and
 * free is not a fallback here, it is the product: capture needs no language
 * model, so a self-hoster runs this at zero recurring cost forever.
 *
 * The model MUST stay resident between calls. If the second request is as slow
 * as the first, whisper is reloading from disk and every latency claim is void.
 *
 * `openai-compatible` is the hosted shape — Groq, OpenAI, and anything that
 * copies their `/audio/transcriptions` route. It exists because a phone-sized
 * machine cannot always run whisper itself, and it is opt-in for the obvious
 * reason: it uploads the recording.
 *
 * `sarvam` is Sarvam AI's `/speech-to-text`. It gets its own branch rather than
 * riding on `openai-compatible` because all three of the things that matter
 * differ: the route, the auth header (`api-subscription-key`, not Bearer), and
 * the response field (`transcript`, not `text`). It is here because Indian
 * languages and code-mixed Hindi-English are where it beats whisper, and that
 * is a real capture language for real users, not a rounding error.
 */
export type SttConfig = {
  provider: "whisper-cpp" | "openai-compatible" | "sarvam";
  /** whisper.cpp's server root, the OpenAI-compatible API base, or Sarvam's. */
  url: string;
  /** Required by openai-compatible; Sarvam defaults it; whisper.cpp ignores it. */
  model?: string;
  /**
   * BCP-47 hint for providers that accept one (`hi-IN`, `en-IN`). Sarvam takes
   * `unknown` to auto-detect, which is the default and usually right.
   */
  language?: string;
  apiKey?: string;
};

/** What Sarvam serves when no model is named. */
export const SARVAM_DEFAULT_MODEL = "saaras:v3";
export const SARVAM_URL = "https://api.sarvam.ai";

export class Stt {
  constructor(private config: SttConfig) {}

  /** The route a capture actually posts to. Worth naming in a failure message. */
  get endpoint(): string {
    switch (this.config.provider) {
      case "whisper-cpp": return `${this.config.url}/inference`;
      case "sarvam": return `${this.config.url}/speech-to-text`;
      default: return `${this.config.url}/audio/transcriptions`;
    }
  }

  /**
   * Sarvam authenticates with its own header name. Sending it as Bearer gets a
   * 401 that reads like a bad key rather than a wrong protocol, so the shape is
   * chosen per provider and never guessed.
   */
  private headers(): Record<string, string> {
    if (!this.config.apiKey) return {};
    return this.config.provider === "sarvam"
      ? { "api-subscription-key": this.config.apiKey }
      : { authorization: `Bearer ${this.config.apiKey}` };
  }

  /**
   * Reachability, not authorization. A server that answers 401 or 404 is up;
   * only a refused connection or a 5xx means captures are about to fail. This
   * feeds a startup alarm and the record button on every paired device, so it
   * must not cry wolf over an endpoint that simply has no route for `/`.
   * Credentials get checked where a wrong answer is actionable: in setup.
   */
  async health(): Promise<boolean> {
    // Sarvam publishes no model listing, so its own base URL is the probe.
    const probe = this.config.provider === "openai-compatible"
      ? `${this.config.url}/models`
      : `${this.config.url}/`;
    try {
      const r = await fetch(probe, { headers: this.headers(), signal: AbortSignal.timeout(2000) });
      return r.status < 500;
    } catch {
      return false;
    }
  }

  async transcribe(wav16k: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav16k as BufferSource], { type: "audio/wav" }), "audio.wav");

    if (this.config.provider === "sarvam") {
      form.append("model", this.config.model || SARVAM_DEFAULT_MODEL);
      // `unknown` is Sarvam's own auto-detect value. Omitting the field entirely
      // is not the same thing on every model, so it is always sent.
      form.append("language_code", this.config.language || "unknown");
    } else {
      form.append("response_format", "json");
      // The hosted shape names a model per request. whisper.cpp serves the one it
      // was started with and takes a sampling temperature instead.
      if (this.config.provider === "whisper-cpp") form.append("temperature", "0");
      else form.append("model", this.config.model ?? "");
    }

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const ct = res.headers.get("content-type") ?? "";
    let raw: string;
    if (ct.includes("json")) {
      // whisper.cpp and the OpenAI shape answer `text`; Sarvam answers `transcript`.
      const body = (await res.json()) as { text?: string; transcript?: string };
      raw = body.text ?? body.transcript ?? "";
    } else {
      raw = await res.text();
    }
    return stripNonSpeech(raw);
  }
}

/**
 * A `/models` listing is every model the account can reach, mostly chat ones.
 * Posting audio to a chat model fails in a confusing way, so setup only offers
 * the ids that name themselves as speech models. Covers whisper-large-v3 and
 * distil-whisper on Groq, whisper-1 and gpt-4o-transcribe on OpenAI, plus
 * Mistral's voxtral and ElevenLabs' scribe.
 */
export const SPEECH_MODEL = /whisper|transcribe|transcription|speech|voxtral|scribe/i;

/**
 * whisper does not return an empty string for silence. It returns markers:
 * `[BLANK_AUDIO]`, `(silence)`, `[MUSIC]`, `(wind blowing)` and friends.
 *
 * Taken literally, a dead microphone produces a note whose entire content is
 * `[BLANK_AUDIO]`. For a push-to-talk device that is the worst outcome available:
 * the capture looks like it succeeded, you get a confirmation, and the thought is
 * gone. So a transcript made up ONLY of bracketed markers counts as silence, and
 * the caller turns that into a failure the user is actually told about.
 *
 * Bracketed text mixed with real words is left alone, because that is speech.
 */
export function stripNonSpeech(text: string): string {
  const withoutMarkers = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutMarkers.length === 0 ? "" : text.trim();
}
