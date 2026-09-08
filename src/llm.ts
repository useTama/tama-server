import Anthropic from "@anthropic-ai/sdk";

/**
 * The LLM slot, behind one streaming-shaped interface.
 *
 * There are two adapters because there are two wire formats, not because there
 * are two vendors. OpenAiCompatibleLlm reaches Ollama, llama.cpp, LM Studio,
 * vLLM, OpenAI, Groq, OpenRouter, Together and DeepInfra, because all of them
 * speak the same /chat/completions SSE dialect. AnthropicLlm exists separately
 * because the Messages API is not that shape: the system prompt is a top-level
 * parameter rather than a message, so no amount of field renaming makes one
 * client cover both.
 *
 * The interface is streaming-shaped even for a provider that cannot stream: a
 * one-shot provider is wrapped to emit a single chunk. Callers then have exactly
 * one consumption pattern to write, and swapping providers never rewrites a call
 * site.
 */

/**
 * No "system" role here. The system prompt travels beside the messages because
 * Anthropic requires it beside them, and the OpenAI adapter can always fold it
 * back in. Doing it the other way round would mean unpicking a message list.
 */
export type LlmMessage = { role: "user" | "assistant"; content: string };

/**
 * What a completion cost and how it ended.
 *
 * Reported through a callback rather than returned, because `stream` yields
 * text and both facts arrive at the end - after the last token for usage, and
 * only with the final event for the stop reason. Returning them would mean
 * changing what the generator yields, which every caller would have to unpack.
 */
export type LlmUsage = {
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Why generation stopped. `length` is the one that matters: it means the
   * answer was truncated at max_tokens, which looks exactly like a short answer
   * to everyone downstream. Normalised across providers because "stop" and
   * "end_turn" are the same thing said twice.
   */
  stopReason?: "stop" | "length" | "tool" | "filtered" | "other";
  /** Tokens the provider says it served from a cache. Absent when unreported. */
  cachedInputTokens?: number;
};

export interface Llm {
  readonly name: string;
  stream(opts: {
    system: string;
    messages: LlmMessage[];
    /**
     * Called once, after the stream ends. Never throws into the stream: a
     * caller that fails to log must not fail the answer that was already
     * delivered.
     */
    onUsage?: (usage: LlmUsage) => void;
  }): AsyncIterable<string>;
}

/** Providers spell the same handful of endings several different ways. */
export function normaliseStopReason(raw: unknown): LlmUsage["stopReason"] {
  const reason = String(raw ?? "").toLowerCase();
  if (!reason) return undefined;
  if (reason === "length" || reason === "max_tokens" || reason === "model_length") return "length";
  if (reason === "stop" || reason === "end_turn" || reason === "stop_sequence" || reason === "eos") return "stop";
  if (reason.includes("tool") || reason.includes("function")) return "tool";
  if (reason.includes("content") || reason.includes("safety") || reason.includes("filter")) return "filtered";
  return "other";
}

/**
 * Silence budget for a stream, not a total deadline. Generous because the first
 * token includes prompt processing, and a cold local model on CPU can spend
 * minutes there before it produces a single byte.
 */
const IDLE_MS = 180_000;

/** Ceiling on the buffered fallback body. See the `raw` buffer in stream(). */
const NON_SSE_CAP = 1_000_000;

/**
 * One client for every OpenAI-shaped endpoint.
 *
 * Written against fetch on purpose. The wire format IS the abstraction this
 * adapter provides, so an SDK that hides it would be a layer between us and the
 * only thing we care about, plus a dependency to keep in step with nine
 * providers' quirks.
 */
export class OpenAiCompatibleLlm implements Llm {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly model: string;

  private readonly maxTokens: number;

  constructor(opts: { baseUrl: string; apiKey?: string; model: string; maxTokens?: number }) {
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.baseUrl = normalizeBaseUrl(
      requireField(opts.baseUrl, "llm.baseUrl", 'ollama: "http://127.0.0.1:11434/v1"'),
    );
    this.model = requireField(
      opts.model,
      "llm.model",
      'on ollama this is the pulled tag, e.g. "qwen2.5:7b"',
    );
    // An empty string in the config means "no key", not "send an empty key".
    // A local Ollama needs none, and `Authorization: Bearer ` with nothing
    // after it is a 401 on several gateways that would otherwise have served
    // the request.
    this.apiKey = opts.apiKey?.trim() || undefined;
    this.name = `openai-compatible:${this.model}`;
  }

  async *stream(opts: { system: string; messages: LlmMessage[]; onUsage?: (u: LlmUsage) => void }): AsyncIterable<string> {
    // Accumulated across frames: providers split usage and finish_reason over
    // separate events, and some send neither.
    const usage: LlmUsage = {};
    const reportUsage = () => {
      if (!opts.onUsage || Object.keys(usage).length === 0) return;
      // Never let a logging callback break an answer that already arrived.
      try {
        opts.onUsage(usage);
      } catch (e) {
        console.error("onUsage threw:", e instanceof Error ? e.message : e);
      }
    };
    const url = `${this.baseUrl}/chat/completions`;

    // The watchdog fires on silence, never on duration. A long answer over a
    // long note legitimately outruns any total budget, which is why
    // AbortSignal.timeout is the wrong tool: it also kills a healthy stream
    // that is still arriving. Every read re-arms this one, so it trips only
    // when the provider has stopped producing bytes at all.
    const ctl = new AbortController();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        ctl.abort(
          new Error(
            `${this.name}: no bytes for ${IDLE_MS / 1000}s. is the provider at ${url} still running?`,
          ),
        );
      }, IDLE_MS);
    };

    arm();
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          signal: ctl.signal,
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: this.model,
            stream: true,
            // Sent even though the field is optional here: omitting it means
            // the gateway's own default, which can be the model's maximum and
            // large enough to be rejected as unaffordable before a token is
            // generated.
            max_tokens: this.maxTokens,
            // Off by default in this API shape, and without it a truncated
            // answer is indistinguishable from a short one. Harmless on
            // providers that ignore it.
            stream_options: { include_usage: true },
            // The system prompt is a message with role "system" in this format.
            // The Anthropic adapter below does the opposite, and that contrast
            // is the whole reason both files' worth of code exists.
            messages: [{ role: "system", content: opts.system }, ...opts.messages],
          }),
        });
      } catch (e) {
        if (ctl.signal.aborted) throw ctl.signal.reason;
        throw new Error(
          `${this.name}: cannot reach ${url}\n` +
            `  fix: start the provider, or correct llm.baseUrl (ollama, llama.cpp and LM Studio need the /v1 path segment)`,
          { cause: e },
        );
      }

      if (!res.ok) {
        const body = (await res.text().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 300);
        throw new Error(
          `${this.name}: ${res.status} from ${url}: ${body}\n` +
            `  401 or 403: set llm.apiKey (a local ollama or llama.cpp needs none)\n` +
            `  404: llm.baseUrl needs its /v1 path segment, and llm.model "${this.model}" must exist on that server`,
        );
      }
      if (!res.body) {
        throw new Error(
          `${this.name}: ${url} answered ${res.status} with no body at all\n` +
            `  fix: check llm.baseUrl points at a chat completions endpoint, not a health or proxy route`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      // Kept only until the first `data:` line proves this really is an SSE
      // stream. Some providers and most reverse proxies quietly ignore
      // "stream": true and answer with one ordinary completion, and a parser
      // that only looks for `data:` lines turns that into an empty answer with
      // no error anywhere. The cap is there so a provider emitting
      // unrecognised lines forever cannot grow this without bound.
      let raw = "";
      let sawData = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          arm();
          const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
          buf += chunk;
          if (!sawData && raw.length < NON_SSE_CAP) raw += chunk;

          const split = takeLines(buf);
          buf = split.rest;
          // At EOF the unterminated tail is a whole frame. A provider that
          // closes without a trailing newline would otherwise lose its last
          // delta, which reads as a truncated answer rather than a bug.
          const lines = done && buf.length > 0 ? [...split.lines, buf] : split.lines;

          for (const line of lines) {
            if (!sawData && line.trim().startsWith("data:")) {
              sawData = true;
              raw = "";
            }
            const frame = decodeSseFrame(line);
            if (frame.kind === "text") yield frame.text;
            else if (frame.kind === "usage") Object.assign(usage, frame.usage);
            else if (frame.kind === "done") {
              reportUsage();
              return;
            } else if (frame.kind === "error") {
              throw new Error(`${this.name}: provider failed mid-stream: ${frame.message}`);
            }
          }

          if (done) {
            if (sawData) {
              reportUsage();
              return;
            }
            // Streaming-shaped interface, non-streaming provider: emit the whole
            // completion as a single chunk so the caller never learns the
            // difference.
            const whole = decodeWholeCompletion(raw);
            if (whole !== null) {
              yield whole;
              return;
            }
            throw new Error(
              `${this.name}: ${url} sent no sse frames and no completion body\n` +
                `  it answered ${res.status} with: ${raw.replace(/\s+/g, " ").trim().slice(0, 200)}\n` +
                `  fix: check llm.baseUrl points at an openai-compatible chat completions endpoint`,
            );
          }
        }
      } catch (e) {
        // The watchdog's own message names the fix; anything wrapped around it
        // would bury it.
        if (ctl.signal.aborted) throw ctl.signal.reason;
        throw e;
      } finally {
        // Releases the socket when the caller abandons the answer half-read.
        // Without this the connection stays open until the provider gives up.
        void reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(watchdog);
    }
  }
}

/**
 * The output cap, sent on every request, and low by design.
 *
 * It is not only a spend limit. A gateway checks the balance against
 * `max_tokens` before running anything, so an uncapped request inherits the
 * model's own maximum - 65536 on some - and is refused outright as
 * unaffordable, however short the answer would have been. Not sending the field
 * is therefore the expensive choice, not the permissive one.
 *
 * 2048 is a long answer over a handful of notes. Raise it with `ask.maxTokens`
 * when the questions warrant it and the balance covers it.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

/**
 * What one completion cost, as a log fragment.
 *
 * Lived inline in the one route that reported it. Every other place that spends
 * money - the routing pass that files a note, conversation summarising, a
 * session summary, the streaming half of ask, the WhatsApp worker - either had
 * no such line or dropped the usage it was handed. So the bill had one
 * instrument on it and five paths that bypassed the instrument, which is how a
 * 402 arrives as a surprise rather than as a trend.
 *
 * Shared rather than copied so the five cannot drift into five formats.
 */
export function spendLabel(usage?: LlmUsage): string {
  if (!usage) return "";
  const cached = usage.cachedInputTokens ? ` (${usage.cachedInputTokens} cached)` : "";
  return ` ${usage.inputTokens ?? "?"}in/${usage.outputTokens ?? "?"}out${cached}`;
}

/**
 * Anthropic via the official SDK.
 *
 * Hand-rolled HTTP here would buy nothing and cost retries, error typing and
 * event parsing, all of which the SDK already has.
 */
export class AnthropicLlm implements Llm {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  private readonly maxTokens: number;

  constructor(opts: { apiKey?: string; model: string; maxTokens?: number }) {
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.model = requireField(opts.model, "llm.model", 'e.g. "claude-sonnet-5"');
    const apiKey = opts.apiKey?.trim();
    // A bare `new Anthropic()` resolves ANTHROPIC_API_KEY from the environment,
    // so an unset llm.apiKey is a working configuration rather than a missing
    // one, and the better default: the config file sits next to a git-tracked
    // vault, where a secret does not belong. Passing a key only when one was
    // actually configured leaves that resolution intact.
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    this.name = `anthropic:${this.model}`;
  }

  async *stream(opts: { system: string; messages: LlmMessage[]; onUsage?: (u: LlmUsage) => void }): AsyncIterable<string> {
    // `system` is its own top-level parameter, not a message with role
    // "system". That is the core wire difference from OpenAI and the reason
    // this adapter is not a config change on the other one.
    //
    // Nothing else goes on the wire, deliberately. No `thinking`: budget_tokens
    // is rejected with a 400 on current models and the default behaviour is
    // what we want anyway. No temperature or top_p: current models reject
    // sampling parameters outright, so the `temperature: 0` habit from stt.ts
    // does not transfer. Leaving all three out is also what keeps this working
    // when llm.model is bumped to the next release.
    const s = this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      system: opts.system,
      messages: opts.messages,
    });

    try {
      // Abandoning this generator closes the request on its own: exiting the
      // for-await calls the SDK iterator's return(), which aborts the stream.
      // An explicit abort here would be redundant, and calling one before
      // iteration has registered its listeners is what produces the SDK's
      // stray unhandled rejection.
      const usage: LlmUsage = {};
      for await (const event of s) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
        // Input tokens land on message_start, output and the stop reason on
        // message_delta. Two events, one accounting.
        if (event.type === "message_start") {
          const u = event.message?.usage;
          if (typeof u?.input_tokens === "number") usage.inputTokens = u.input_tokens;
          if (typeof (u as { cache_read_input_tokens?: number })?.cache_read_input_tokens === "number") {
            usage.cachedInputTokens = (u as { cache_read_input_tokens?: number }).cache_read_input_tokens;
          }
        }
        if (event.type === "message_delta") {
          if (typeof event.usage?.output_tokens === "number") usage.outputTokens = event.usage.output_tokens;
          const stop = normaliseStopReason(event.delta?.stop_reason);
          if (stop) usage.stopReason = stop;
        }
      }
      if (opts.onUsage && Object.keys(usage).length > 0) {
        // Never let a logging callback break an answer that already arrived.
        try {
          opts.onUsage(usage);
        } catch (e) {
          console.error("onUsage threw:", e instanceof Error ? e.message : e);
        }
      }
    } catch (e) {
      throw describeAnthropicFailure(e, this.name);
    }
  }
}

export type LlmConfig =
  | { provider: "openai-compatible"; baseUrl: string; apiKey?: string; model: string; maxTokens?: number }
  | { provider: "anthropic"; apiKey?: string; model: string; maxTokens?: number };

/**
 * Field validation lives in the constructors, not here, so that constructing an
 * adapter directly cannot skip it. This function owns the one check a
 * constructor cannot make: whether `provider` names a provider at all, which is
 * the failure a hand-edited config file actually produces.
 */
export function makeLlm(cfg: LlmConfig): Llm {
  // The optional chain is not dead code. This value comes from parsed JSON, so
  // the type is a claim about the config file, not a guarantee about the object.
  switch (cfg?.provider) {
    case "openai-compatible":
      return new OpenAiCompatibleLlm(cfg);
    case "anthropic":
      return new AnthropicLlm(cfg);
    default: {
      const got = (cfg as { provider?: unknown } | null | undefined)?.provider;
      throw new Error(
        `config: unknown llm.provider ${JSON.stringify(got) ?? "undefined"}\n` +
          `  "openai-compatible": ollama, llama.cpp, LM Studio, vLLM, openai, groq, openrouter, together, deepinfra\n` +
          `  "anthropic": the Messages API`,
      );
    }
  }
}

export type SseFrame =
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  | { kind: "usage"; usage: LlmUsage }
  | { kind: "done" }
  | { kind: "skip" };

/**
 * Decode one line of a /chat/completions stream.
 *
 * Most lines are not tokens. Blank lines and `:` comments are how a provider
 * holds the connection open between tokens, `event:` and `id:` fields show up
 * from some gateways, the opening frame carries `delta.role` with no content and
 * the closing one carries `finish_reason` with an empty delta. Treating any of
 * those as an anomaly would abort streams that are working perfectly.
 */
export function decodeSseFrame(line: string): SseFrame {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return { kind: "skip" };

  const payload = trimmed.slice("data:".length).trim();
  // The sentinel is not JSON, and not every provider sends it, so end of stream
  // is also just the reader reaching EOF.
  if (payload === "[DONE]") return { kind: "done" };
  if (payload === "") return { kind: "skip" };

  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    // Not fatal, and not a truncation either: only complete lines reach here.
    // A proxy injecting a non-JSON notice mid-stream should not throw away an
    // answer that is otherwise arriving intact.
    return { kind: "skip" };
  }

  const f = frame as {
    error?: unknown;
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
    choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown } | undefined>;
  };
  // vLLM and several gateways report a failure as a frame, long after a 200 has
  // gone out. Skipping it truncates the answer with no sign that anything went
  // wrong, which is the one outcome worth being loud about.
  if (f.error !== undefined && f.error !== null) {
    const message =
      typeof f.error === "string" ? f.error : JSON.stringify(f.error).slice(0, 300);
    return { kind: "error", message };
  }

  // Only `content`. DeepSeek-style `reasoning_content` is left on the floor: it
  // is the model thinking out loud, not the answer, and the caller renders
  // whatever it is handed.
  const content = f.choices?.[0]?.delta?.content;
  if (typeof content === "string" && content.length > 0) return { kind: "text", text: content };

  // Usage and the stop reason arrive on their own frames near the end, usually
  // one with an empty choices array. They were being skipped, which is why a
  // truncated answer was indistinguishable from a short one.
  const usage: LlmUsage = {};
  if (typeof f.usage?.prompt_tokens === "number") usage.inputTokens = f.usage.prompt_tokens;
  if (typeof f.usage?.completion_tokens === "number") usage.outputTokens = f.usage.completion_tokens;
  if (typeof f.usage?.prompt_tokens_details?.cached_tokens === "number") {
    usage.cachedInputTokens = f.usage.prompt_tokens_details.cached_tokens;
  }
  const stop = normaliseStopReason(f.choices?.[0]?.finish_reason);
  if (stop) usage.stopReason = stop;
  if (Object.keys(usage).length > 0) return { kind: "usage", usage };

  return { kind: "skip" };
}

/**
 * Pull the answer out of a whole, unstreamed chat completion body.
 *
 * Returns null when the body is not one, which is the signal to report a
 * misconfigured endpoint rather than to invent an answer from an error page.
 * `choices[0].text` is checked too because a few servers answer a chat request
 * with the older /completions shape.
 */
export function decodeWholeCompletion(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const p = parsed as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown } | undefined>;
  };
  const choice = p.choices?.[0];
  const content = choice?.message?.content ?? choice?.text;
  return typeof content === "string" && content.length > 0 ? content : null;
}

/**
 * Split a read buffer into complete lines and hand back the unterminated tail.
 *
 * A network read boundary lands wherever it likes: one delta can arrive as
 * `data: {"choi` and then `ces":[...]}\n`. Parsing per read rather than per line
 * turns that into a dropped token, which looks like the model quietly skipping a
 * word. The tail has to be carried into the next read.
 */
export function takeLines(buf: string): { lines: string[]; rest: string } {
  const parts = buf.split("\n");
  const rest = parts.pop() ?? "";
  // A trailing \r from a CRLF provider would otherwise ride into JSON.parse and
  // into the [DONE] comparison, and break both.
  return { lines: parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)), rest };
}

/**
 * Reject an http(s)-less or trailing-slashed base URL at construction rather
 * than at the first request. `{baseUrl}/chat/completions` with a trailing slash
 * becomes a double-slashed path that some gateways route to a 404, and a
 * hand-written config ends in a slash about half the time.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `config: llm.baseUrl is not a url: ${JSON.stringify(raw)}\n` +
        `  it needs a scheme, e.g. "http://127.0.0.1:11434/v1"`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`config: llm.baseUrl must be http or https, got "${parsed.protocol}"`);
  }
  return trimmed;
}

function requireField(value: string | undefined, key: string, hint: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`config: ${key} is required\n  ${hint}`);
  return v;
}

/**
 * Order matters. AuthenticationError and RateLimitError both extend APIError, so
 * a broad APIError branch placed first swallows exactly the two cases that have
 * a specific fix. Matching on classes instead of message text is what keeps this
 * working when the API rewords something.
 */
function describeAnthropicFailure(e: unknown, name: string): Error {
  if (e instanceof Anthropic.AuthenticationError) {
    return new Error(
      `${name}: the api key was rejected (401)\n` +
        `  fix: export ANTHROPIC_API_KEY, or set llm.apiKey in the config`,
      { cause: e },
    );
  }
  if (e instanceof Anthropic.RateLimitError) {
    return new Error(
      `${name}: rate limited (429)\n` +
        `  fix: retry, or set llm.provider to "openai-compatible" and point llm.baseUrl at a local model`,
      { cause: e },
    );
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return new Error(`${name}: could not reach the anthropic api. check the network, then retry`, {
      cause: e,
    });
  }
  if (e instanceof Anthropic.APIError) {
    // The SDK's message already opens with the status code, so repeating
    // e.status here just prints it twice.
    return new Error(
      `${name}: ${String(e.message).slice(0, 300)}\n` +
        `  a 404 here usually means llm.model is not a model id this key can reach`,
      { cause: e },
    );
  }
  return e instanceof Error ? e : new Error(`${name}: ${String(e)}`);
}
