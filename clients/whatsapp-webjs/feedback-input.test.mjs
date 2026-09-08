import { expect, test } from "bun:test";
import { verdictFromReaction, verdictFromCommand } from "./feedback-input.mjs";

test("a thumbs down is a verdict, whatever skin tone it arrives in", () => {
  expect(verdictFromReaction("\u{1F44E}")).toBe("wrong");
  expect(verdictFromReaction("\u{1F44E}\u{1F3FD}")).toBe("wrong");
  expect(verdictFromReaction("\u{1F44D}\u{FE0F}")).toBe("right");
});

test("any other reaction is just a reaction", () => {
  // A heart on a good answer is not a verdict, and guessing would put noise
  // into the file the golden set gets written from.
  for (const other of ["\u{2764}\u{FE0F}", "\u{1F602}", "", "wrong", undefined, null, 7]) {
    expect(verdictFromReaction(other)).toBeNull();
  }
});

test("the command carries an optional note, which is the useful part", () => {
  expect(verdictFromCommand("/tama wrong")).toEqual({ verdict: "wrong" });
  expect(verdictFromCommand("/tama wrong: answered about a github issue")).toEqual({
    verdict: "wrong",
    note: "answered about a github issue",
  });
  expect(verdictFromCommand("/tama WRONG - meant the 500")).toEqual({ verdict: "wrong", note: "meant the 500" });
  expect(verdictFromCommand("/tama right")).toEqual({ verdict: "right" });
});

test("a bare word is never a verdict", () => {
  // "right, so what about the rent" is a question. Hijacking these would cost
  // an answer every time somebody spoke normally.
  for (const text of ["wrong", "right", "nope", "right, so what about the rent", "that is wrong"]) {
    expect(verdictFromCommand(text)).toBeNull();
  }
});

test("the command does not swallow a chat claim", () => {
  // "/tama 315" claims this chat as an audience. Only wrong and right are
  // verdicts, so the claim still reaches its own handler.
  expect(verdictFromCommand("/tama 315")).toBeNull();
  expect(verdictFromCommand("/tama")).toBeNull();
  expect(verdictFromCommand("/tama crew")).toBeNull();
});
