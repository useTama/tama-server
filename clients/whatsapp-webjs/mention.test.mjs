import { expect, test } from "bun:test";
import { stripOurMention } from "./mention.mjs";

const us = ["918088775227"];

test("our own mention is not part of the question", () => {
  // The bug: the model was handed "@<my own number> hello" beside a prompt
  // stating that number is its own, and answered "you are saying hello to
  // yourself" four times in a row.
  expect(stripOurMention("@918088775227 hello", us)).toBe("hello");
  expect(stripOurMention("hey @918088775227 what did I decide", us)).toBe("hey what did I decide");
  expect(stripOurMention("@918088775227 @918088775227 hi", us)).toBe("hi");
});

test("somebody else's mention survives, because it is who they meant", () => {
  expect(stripOurMention("@919792975227 look at this", us)).toBe("@919792975227 look at this");
});

test("a longer number that starts with ours is left alone", () => {
  // Stripping on a prefix left a stray digit in the question.
  expect(stripOurMention("@9180887752279 hi", us)).toBe("@9180887752279 hi");
});

test("a bare mention is the whole message, so it is kept", () => {
  // Better to send the number than to send nothing.
  expect(stripOurMention("@918088775227", us)).toBe("@918088775227");
  expect(stripOurMention("  @918088775227  ", us)).toBe("@918088775227");
});

test("every identifier we answer to is stripped, lid ids included", () => {
  expect(stripOurMention("@112233445566778 hello", ["918088775227", "112233445566778"])).toBe("hello");
});

test("no identifiers, or none of ours, changes nothing", () => {
  expect(stripOurMention("hello", us)).toBe("hello");
  expect(stripOurMention("hello", [])).toBe("hello");
  expect(stripOurMention("hello", undefined)).toBe("hello");
});
