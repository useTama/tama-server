/**
 * Speech to text via whisper.cpp's bundled HTTP server, held resident.
 *
 * Local and free is not a fallback here, it is the product: capture needs no
 * language model, so a self-hoster runs this at zero recurring cost forever.
 *
 * The model MUST stay resident between calls. If the second request is as slow
 * as the first, whisper is reloading from disk and every latency claim is void.
 */
export class Stt {
  constructor(private url: string) {}

  async health(): Promise<boolean> {
    try {
      const r = await fetch(`${this.url}/`, { signal: AbortSignal.timeout(2000) });
      return r.status < 500;
    } catch {
      return false;
    }
  }

  async transcribe(wav16k: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav16k as BufferSource], { type: "audio/wav" }), "audio.wav");
    form.append("response_format", "json");
    form.append("temperature", "0");

    const res = await fetch(`${this.url}/inference`, {
      method: "POST",
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
