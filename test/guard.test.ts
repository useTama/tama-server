import { test, expect } from "bun:test";
import {
  citedPaths, stripUnsupportedCitations, unsupportedCitations,
} from "../src/guard.ts";

const SHOWN = ["Work/latency-investigation.md", "Inbox/2025-01-08-1412-mic-gain.md"];

// ---------------------------------------------------------------- reading paths

test("a path is read out of a citation", () => {
  expect(citedPaths("the serialiser does an n+1 on tags (Work/latency-investigation.md)"))
    .toEqual(["Work/latency-investigation.md"]);
});

test("an answer with no paths cites nothing", () => {
  expect(citedPaths("nothing in your notes about that")).toEqual([]);
});

// The first version's character class contained a literal space, so this
// matched from the "a" of "as" and produced the citation "as you wrote in
// Work/notes.md". Under an eval that over-reports; under a guard that edits
// text it would have deleted most of the sentence.
test("a path does not swallow the words in front of it", () => {
  expect(citedPaths("as you wrote in Work/notes.md yesterday")).toEqual(["Work/notes.md"]);
});

test("a bare filename counts as citing its note", () => {
  // Grading the folder prefix would measure formatting, not grounding.
  expect(unsupportedCitations("gain was clipping (2025-01-08-1412-mic-gain.md)", SHOWN)).toEqual([]);
});

test("a path that was never in the context is unsupported", () => {
  expect(unsupportedCitations("as you wrote (Work/latency-notes.md)", SHOWN))
    .toEqual(["Work/latency-notes.md"]);
});

// ---------------------------------------------------------------- stripping

test("an answer with nothing wrong comes back byte-identical", () => {
  const answer = "gain was 60, anything higher clipped (Inbox/2025-01-08-1412-mic-gain.md)";
  expect(stripUnsupportedCitations(answer, SHOWN)).toEqual({ answer, stripped: [] });
});

test("an invented citation goes, and the sentence stays", () => {
  const { answer, stripped } = stripUnsupportedCitations(
    "tariq left comments on the pr (Projects/kubeflow/pr-3138.md)", SHOWN,
  );
  // The claim may be sound and the path mis-remembered. Deleting a true
  // statement to punish a bad citation trades one silent error for another.
  expect(answer).toBe("tariq left comments on the pr");
  expect(stripped).toEqual(["Projects/kubeflow/pr-3138.md"]);
});

test("the real path survives a group that also held an invented one", () => {
  const { answer } = stripUnsupportedCitations(
    "two things happened (Work/latency-investigation.md, Applications/reminders.md)", SHOWN,
  );
  expect(answer).toBe("two things happened (Work/latency-investigation.md)");
});

test("no sentence is left ending in a stranded space or bracket", () => {
  const { answer } = stripUnsupportedCitations("that is done (Nope.md).", SHOWN);
  expect(answer).toBe("that is done.");
});

test("a path cited bare mid-sentence is removed too", () => {
  const { answer } = stripUnsupportedCitations("I read it in Made/up.md this morning", SHOWN);
  expect(answer).toBe("I read it in this morning");
});

test("prose inside brackets is not mistaken for a citation group", () => {
  const { answer } = stripUnsupportedCitations(
    "the gain was 60 (you wrote that in Made/up.md, remember)", SHOWN,
  );
  // The group is not a citation, so only the path comes out and the words stay.
  expect(answer).toContain("you wrote that in");
  expect(answer).toContain("remember");
  expect(answer).not.toContain("Made/up.md");
});

test("newlines survive, because an answer that used them meant to", () => {
  const { answer } = stripUnsupportedCitations("one (Bad.md)\ntwo (Work/latency-investigation.md)", SHOWN);
  expect(answer).toBe("one\ntwo (Work/latency-investigation.md)");
});
