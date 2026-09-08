import { test, expect } from "bun:test";
import { decodeSseFrame, normaliseStopReason, spendLabel, AnthropicLlm, type LlmUsage } from "../src/llm.ts";

test("a usage frame is decoded rather than skipped", () => {
  // These arrive near the end, usually on a frame with an empty choices array,
  // and were being dropped: which is why a truncated answer was
  // indistinguishable from a short one.
  const frame = decodeSseFrame('data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":48,"prompt_tokens_details":{"cached_tokens":1024}}}');
  expect(frame).toEqual({
    kind: "usage",
    usage: { inputTokens: 1200, outputTokens: 48, cachedInputTokens: 1024 },
  });
});

test("a finish_reason of length is reported as truncation", () => {
  expect(decodeSseFrame('data: {"choices":[{"delta":{},"finish_reason":"length"}]}')).toEqual({
    kind: "usage",
    usage: { stopReason: "length" },
  });
  // A normal ending is still usage, so the caller learns why it stopped.
  expect(decodeSseFrame('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}')).toEqual({
    kind: "usage",
    usage: { stopReason: "stop" },
  });
});

test("text still wins over usage on a frame carrying both", () => {
  // Some providers attach usage to the last content frame. Yielding the text is
  // what matters; losing a token count is survivable, losing a word is not.
  expect(decodeSseFrame('data: {"choices":[{"delta":{"content":"hi"}}],"usage":{"completion_tokens":1}}')).toEqual({
    kind: "text",
    text: "hi",
  });
});

test("stop reasons are normalised across the names providers use", () => {
  expect(normaliseStopReason("max_tokens")).toBe("length");
  expect(normaliseStopReason("end_turn")).toBe("stop");
  expect(normaliseStopReason("tool_calls")).toBe("tool");
  expect(normaliseStopReason("content_filter")).toBe("filtered");
  expect(normaliseStopReason("something_new")).toBe("other");
  // Absent rather than guessed, so a caller can tell "not reported" from "ended
  // normally" - a local model reports neither.
  expect(normaliseStopReason(undefined)).toBeUndefined();
  expect(normaliseStopReason("")).toBeUndefined();
});

test("spendLabel is empty when there is nothing to report, and one shape when there is", () => {
  // Shared because it used to live inline in the single route that reported
  // spend, while five other paths that spend money reported nothing. Five
  // copies would have become five formats.
  expect(spendLabel(undefined)).toBe("");
  expect(spendLabel({})).toBe(" ?in/?out");
  expect(spendLabel({ inputTokens: 1200, outputTokens: 340 })).toBe(" 1200in/340out");
  expect(spendLabel({ inputTokens: 1200, outputTokens: 340, cachedInputTokens: 900 }))
    .toBe(" 1200in/340out (900 cached)");
  // Zero is not "no cache", it is a reported miss, and printing "(0 cached)"
  // on every uncached request is noise.
  expect(spendLabel({ inputTokens: 5, outputTokens: 5, cachedInputTokens: 0 })).toBe(" 5in/5out");
});

test("the Anthropic adapter marks the system prompt as a cacheable prefix", async () => {
  // #24. The prefix was already built to be stable - ask.ts assembles the core
  // first and unchanged, and deliberately puts today's date and the retrieved
  // excerpts in the user message so this block stays byte-identical - and
  // cache_read_input_tokens was already mapped into LlmUsage. So the
  // instrument existed, the prefix existed, and nothing ever set the flag.
  const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  let sent: { system?: unknown } = {};

  const fake = (async (_url: unknown, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    const body =
      frame("message_start", {
        type: "message_start",
        message: {
          id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5",
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 8 },
        },
      }) +
      frame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      frame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }) +
      frame("content_block_stop", { type: "content_block_stop", index: 0 }) +
      frame("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } }) +
      frame("message_stop", { type: "message_stop" });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;

  const llm = new AnthropicLlm({ apiKey: "sk-test", model: "claude-sonnet-5", fetch: fake });
  let usage: LlmUsage | undefined;
  let text = "";
  for await (const delta of llm.stream({
    system: "You are Tama.",
    messages: [{ role: "user", content: "hello" }],
    onUsage: (u) => { usage = u; },
  })) {
    text += delta;
  }

  expect(text).toBe("hi");
  // The block form is the only way to carry cache_control, so a regression to
  // the plain string is what this asserts against.
  expect(sent.system).toEqual([
    { type: "text", text: "You are Tama.", cache_control: { type: "ephemeral" } },
  ]);
  // And the reader that was always there now has something to read.
  expect(usage?.cachedInputTokens).toBe(8);
  expect(usage?.stopReason).toBe("stop");
});
