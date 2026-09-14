import { expect, test } from "bun:test";
import { noteFromCommand, wasForwarded } from "./note-input.mjs";

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
