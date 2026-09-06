/**
 * Speech to text. Two wire formats, one client.
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
 */
export type SttConfig = {
  provider: "whisper-cpp" | "openai-compatible";
  /** whisper.cpp's server root, or the OpenAI-compatible API base. */
  url: string;
  /** Required by openai-compatible. whisper.cpp serves whatever it was started with. */
  model?: string;
  apiKey?: string;
};

export class Stt {
  constructor(private config: SttConfig) {}

  /** The route a capture actually posts to. Worth naming in a failure message. */
  get endpoint(): string {
    return this.config.provider === "whisper-cpp"
      ? `${this.config.url}/inference`
      : `${this.config.url}/audio/transcriptions`;
  }

  private headers(): Record<string, string> {
    return this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {};
  }

  /**
   * Reachability, not authorization. A server that answers 401 or 404 is up;
   * only a refused connection or a 5xx means captures are about to fail. This
   * feeds a startup alarm and the record button on every paired device, so it
   * must not cry wolf over an endpoint that simply has no route for `/`.
   * Credentials get checked where a wrong answer is actionable: in setup.
   */
  async health(): Promise<boolean> {
    const probe = this.config.provider === "whisper-cpp" ? `${this.config.url}/` : `${this.config.url}/models`;
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
    form.append("response_format", "json");
    // The hosted shape names a model per request. whisper.cpp serves the one it
    // was started with and takes a sampling temperature instead.
    if (this.config.provider === "whisper-cpp") form.append("temperature", "0");
    else form.append("model", this.config.model ?? "");

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: form,
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) throw new Error(`stt ${res.status}: ${(await res.text()).slice(0, 200)}`);

    const ct = res.headers.get("content-type") ?? "";
    const raw = ct.includes("json")
      ? (((await res.json()) as { text?: string; transcription?: string }).text ?? "")
      : await res.text();
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
