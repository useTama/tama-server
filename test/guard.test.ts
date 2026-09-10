import { test, expect } from "bun:test";
import {
  CANNOT_WRITE, NOTHING_SOLID, citedPaths, claimedWrite, stripUnsupportedCitations,
  unsupportedCitations,
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

// An empty string is worse than a stripped one: a WhatsApp send is refused for
// an empty body, and /ask would return a successful response with no answer.
test("an answer that was nothing but an invented citation says so", () => {
  const { answer, stripped } = stripUnsupportedCitations("(Nope.md)", SHOWN);
  expect(answer).toBe(NOTHING_SOLID);
  expect(stripped).toEqual(["Nope.md"]);
});

test("a bracket the model never closed does not survive as a stray", () => {
  // The group pass needs both brackets, so this falls to the second pass and
  // used to leave "see ( and more".
  const { answer } = stripUnsupportedCitations("see (Nope.md and more", SHOWN);
  expect(answer).toBe("see and more");
});

test("newlines survive, because an answer that used them meant to", () => {
  const { answer } = stripUnsupportedCitations("one (Bad.md)\ntwo (Work/latency-investigation.md)", SHOWN);
  expect(answer).toBe("one\ntwo (Work/latency-investigation.md)");
});

// ---------------------------------------------------------------- claimed writes

test("a first-person completed write is caught", () => {
  for (const answer of [
    "added it to your build plan",
    "I've added that to the list",
    "I have saved that note for you",
    "noted, it's in your inbox now",
    "reminder set for tomorrow",
    "I logged that against the project",
  ]) {
    expect(claimedWrite(answer)).toBe(true);
  }
});

// The observed failures were Hinglish. An English-only matcher would have
// caught none of the five real ones.
test("the Hinglish forms are caught, because those are the ones that got through", () => {
  for (const answer of [
    "note add kar diya hai tama ke build plan mein",
    "ye paanch aur add kar liya iict print mein",
    "remind kar diya hai, application list mein add kar lena",
    "now.md aur build plan dono mein note add kar diya hai",
    "likh diya hai",
  ]) {
    expect(claimedWrite(answer)).toBe(true);
  }
});

test("reporting what the notes say is not a claimed write", () => {
  // "You added it" is a statement about something the owner did, and reading a
  // note's contents back has to keep working.
  for (const answer of [
    "you added the tote bag to that list on the 8th",
    "your notes say the reminder is set for friday",
    "three items are still open on that list",
    "you wrote that you had saved the draft already",
    "nothing in your notes about that",
  ]) {
    expect(claimedWrite(answer)).toBe(false);
  }
});

test("the replacement names the limit and hands the action back", () => {
  expect(CANNOT_WRITE).toContain("cannot write");
  expect(CANNOT_WRITE).toContain("nothing was saved");
  // Not "not yet": a reply that promises the feature invites the owner to wait
  // for it instead of writing the note.
  expect(CANNOT_WRITE).not.toContain("not yet");
  // Chat surface rule: a short reply does not end on a full stop.
  expect(CANNOT_WRITE.endsWith(".")).toBe(false);
});
