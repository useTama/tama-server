import { test } from "node:test";
import assert from "node:assert/strict";
import { stripOurMention } from "./mention.mjs";

const us = ["918088775227"];

test("our own mention is not part of the question", () => {
  // The bug: the model was handed "@<my own number> hello" beside a prompt
  // stating that number is its own, and answered "you are saying hello to
  // yourself" four times in a row.
  assert.equal(stripOurMention("@918088775227 hello", us), "hello");
  assert.equal(stripOurMention("hey @918088775227 what did I decide", us), "hey what did I decide");
  assert.equal(stripOurMention("@918088775227 @918088775227 hi", us), "hi");
});

test("somebody else's mention survives, because it is who they meant", () => {
  assert.equal(stripOurMention("@919792975227 look at this", us), "@919792975227 look at this");
});

test("a longer number that starts with ours is left alone", () => {
  // Stripping on a prefix left a stray digit in the question.
  assert.equal(stripOurMention("@9180887752279 hi", us), "@9180887752279 hi");
});

test("a bare mention is the whole message, so it is kept", () => {
  // Better to send the number than to send nothing.
  assert.equal(stripOurMention("@918088775227", us), "@918088775227");
  assert.equal(stripOurMention("  @918088775227  ", us), "@918088775227");
});

test("every identifier we answer to is stripped, lid ids included", () => {
  assert.equal(stripOurMention("@112233445566778 hello", ["918088775227", "112233445566778"]), "hello");
});

test("no identifiers, or none of ours, changes nothing", () => {
  assert.equal(stripOurMention("hello", us), "hello");
  assert.equal(stripOurMention("hello", []), "hello");
  assert.equal(stripOurMention("hello", undefined), "hello");
});
