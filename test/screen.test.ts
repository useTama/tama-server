import { test, expect } from "bun:test";
import { columns, footer, frameWidth, rail, wrap, type Step } from "../src/screen.ts";
import { stripAnsi } from "../src/ui.ts";

const steps: Step[] = [
  { key: "world", title: "World", blurb: "one" },
  { key: "vault", title: "Vault", blurb: "two" },
  { key: "review", title: "Review", blurb: "three" },
];

test("the rail says which step is current and which are done, without colour", () => {
  const plain = stripAnsi(rail(steps, 1));
  expect(plain).toContain("✓ World");
  expect(plain).toContain("▸ Vault");
  expect(plain).toContain("· Review");
});

test("columns pads the left block by its visible width, not its byte length", () => {
  const left = "\x1b[31mab\x1b[39m\ncdef";
  const joined = columns(left, "one\ntwo", 2).split("\n");
  expect(stripAnsi(joined[0]!)).toBe("ab    one");
  expect(stripAnsi(joined[1]!)).toBe("cdef  two");
});

test("columns keeps every right-hand line, even past the left block's height", () => {
  const joined = columns("a", "one\ntwo\nthree", 1).split("\n");
  expect(joined).toHaveLength(3);
  expect(stripAnsi(joined[2]!)).toBe("  three");
});

test("wrap folds on words and never returns an empty list", () => {
  expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  expect(wrap("", 10)).toEqual([""]);
  // A word longer than the width goes on its own line rather than being lost.
  expect(wrap("short overlylongword", 6)).toEqual(["short", "overlylongword"]);
});

test("the footer right-aligns its status inside the frame", () => {
  const line = stripAnsi(footer([{ key: "enter", action: "Confirm" }], "2/6 · Vault"));
  expect(line).toContain("enter Confirm");
  expect(line).toEndWith("2/6 · Vault");
  expect(line.length).toBeLessThanOrEqual(frameWidth() + 2);
});

test("the footer drops to a second line rather than overflowing", () => {
  const line = footer([{ key: "enter", action: "Confirm" }], "x".repeat(frameWidth()));
  expect(line.split("\n")).toHaveLength(2);
});
