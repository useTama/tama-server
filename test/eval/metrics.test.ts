import { test, expect } from "bun:test";
import { citedPaths, unsupportedCitations } from "./metrics.ts";

const RETRIEVED = ["Work/latency-investigation.md", "Inbox/2025-01-08-1412-mic-gain.md"];

test("citations are read out of parentheses", () => {
  expect(citedPaths("the serialiser does an n+1 on tags (Work/latency-investigation.md)"))
    .toEqual(["Work/latency-investigation.md"]);
});

test("a bare filename counts as citing its note", () => {
  // Grading the folder prefix would measure formatting, not grounding.
  expect(unsupportedCitations("gain was clipping (2025-01-08-1412-mic-gain.md)", RETRIEVED))
    .toEqual([]);
});

test("a path that was never in the context is unsupported", () => {
  expect(unsupportedCitations("as you wrote (Work/latency-notes.md)", RETRIEVED))
    .toEqual(["Work/latency-notes.md"]);
});

test("an answer with no paths cites nothing", () => {
  expect(citedPaths("nothing in your notes about that")).toEqual([]);
});
