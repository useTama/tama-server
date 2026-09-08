import { test, expect } from "bun:test";
import { decodeSseFrame, normaliseStopReason, spendLabel } from "../src/llm.ts";

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
