import { expect, test } from "bun:test";
import { looksLikeQuestion, noteFromCommand, wasForwarded, worthKeeping } from "./note-input.mjs";

test("the command carries the note, over as many lines as it takes", () => {
  expect(noteFromCommand("/tama note buy milk")).toEqual({ text: "buy milk" });
  expect(noteFromCommand("/tama note: buy milk")).toEqual({ text: "buy milk" });
  expect(noteFromCommand("/tama NOTE - buy milk")).toEqual({ text: "buy milk" });
  // A pasted block is the whole point of typing the command rather than
  // forwarding, so the newlines have to survive it.
  expect(noteFromCommand("/tama note line one\nline two")).toEqual({ text: "line one\nline two" });
});

test("an empty note is still a note, so it cannot be read as a claim", () => {
  // "/tama note" falling through to null would reach the claim handler, which
  // takes the word after /tama as an audience name and would claim this chat
  // as one called "note".
  expect(noteFromCommand("/tama note")).toEqual({ text: "" });
  expect(noteFromCommand("/tama note   ")).toEqual({ text: "" });
});

test("nothing else is a note command", () => {
  for (const text of ["note buy milk", "a note about the rent", "/tama 315", "/tama", "/tama wrong", "", null, 7]) {
    expect(noteFromCommand(text)).toBeNull();
  }
});

test("the note command does not swallow a chat claim or a verdict", () => {
  // Both are checked against the same "/tama <word>" shape, so each has to
  // leave the others alone.
  expect(noteFromCommand("/tama notes")).toBeNull();
  expect(noteFromCommand("/tama crew")).toBeNull();
});

test("a forward is recognised however the build reports it", () => {
  expect(wasForwarded({ isForwarded: true })).toBe(true);
  expect(wasForwarded({ forwardingScore: 1 })).toBe(true);
  expect(wasForwarded({ forwardingScore: 127 })).toBe(true);
});

test("an ordinary message is not a forward", () => {
  for (const message of [{}, { isForwarded: false }, { forwardingScore: 0 }, { forwardingScore: "many" }, null, "yes"]) {
    expect(wasForwarded(message)).toBe(false);
  }
});

// The session that prompted all of this. Every line below was typed into the
// owner's own chat and answered as though it were a query, which is how a
// notepad, a cap order and a tote bag deadline all failed to reach the vault.
test("the messages that were answered instead of kept are notes", () => {
  for (const text of [
    "i need to go and order this tommorow",
    "the notepad",
    "cap and totebag final tommorow",
  ]) {
    expect(looksLikeQuestion(text)).toBe(false);
    expect(worthKeeping(text)).toBe(true);
  }
});

test("a dropped subject does not make a statement a question", () => {
  // The reason the auxiliaries are not opener words. Speech-to-text and typed
  // notes both drop the subject constantly, and every one of these would have
  // gone back to /ask if `will`, `can`, `got` or `have` opened a question.
  for (const text of [
    "will order the notepad tommorow",
    "can pick the caps up friday",
    "got the totebag sample today",
    "have to confirm with kiks studios",
    "did order them, waiting on the invoice",
  ]) {
    expect(looksLikeQuestion(text)).toBe(false);
  }
});

test("an auxiliary with a subject after it is a question", () => {
  for (const text of ["is it done", "did i order the caps", "should i chase zenith", "has the airframe shipped"]) {
    expect(looksLikeQuestion(text)).toBe(true);
  }
});

test("a question word opens a question, with or without the mark", () => {
  // "why is tama so dumb" arrived with no question mark and has to be answered
  // rather than filed, which is the whole reason the openers exist.
  for (const text of ["why is tama so dumb", "whats left on iict", "when is the workshop", "how many caps"]) {
    expect(looksLikeQuestion(text)).toBe(true);
  }
});

test("Hinglish asks in the same sentence as English", () => {
  for (const text of ["kya iict ka kaam ho gaya", "kab hai workshop", "kitne messages bache hain", "kaise karna hai"]) {
    expect(looksLikeQuestion(text)).toBe(true);
  }
});

test("a question mark settles it whatever the shape", () => {
  // The escape hatch for everything the openers get wrong. A note-shaped line
  // with a mark on the end is a question and is answered.
  expect(looksLikeQuestion("cap and totebag final tommorow?")).toBe(true);
  expect(looksLikeQuestion("the notepad?")).toBe(true);
});

test("asking the vault is a question; telling somebody is a note", () => {
  expect(looksLikeQuestion("tell me about iict")).toBe(true);
  expect(looksLikeQuestion("summarise the anvesha roadmap")).toBe(true);
  // The bare verb would have taken both of these, and both are things to do.
  expect(looksLikeQuestion("tell shivansh about the workshop")).toBe(false);
  expect(looksLikeQuestion("give the totebag to kiks")).toBe(false);
});

test("remind me splits on what follows it", () => {
  // "remind me to X" is the most note-shaped sentence there is, and it carries
  // the open loop routeOnce exists to pick up.
  expect(looksLikeQuestion("remind me to order the notepad")).toBe(false);
  expect(looksLikeQuestion("remind me what i said about iict")).toBe(true);
});

test("a list of things is not a request for a list", () => {
  expect(looksLikeQuestion("list of things to order")).toBe(false);
  expect(looksLikeQuestion("list the open loops")).toBe(true);
});

test("an acknowledgement is neither kept nor a question", () => {
  for (const text of ["ok", "Ok.", "thanks", "yep", "done", "haan", "theek", "accha", "lol"]) {
    expect(worthKeeping(text)).toBe(false);
  }
});

test("a reaction with no words in it is not a note", () => {
  // The same \p{L}\p{N} test guard.ts uses to decide an answer stripped to
  // punctuation is no answer at all.
  for (const text of ["👍", "!!", "...", "", "   ", null, undefined]) {
    expect(worthKeeping(text)).toBe(false);
  }
});

test("a real note survives both gates", () => {
  for (const text of ["cap and totebag final tommorow", "24 messages still unsent via kiks studios", "print cut-off is in 8 days"]) {
    expect(worthKeeping(text)).toBe(true);
    expect(looksLikeQuestion(text)).toBe(false);
  }
});
