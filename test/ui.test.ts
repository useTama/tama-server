import { test, expect } from "bun:test";
import { colourLevel } from "../src/ui.ts";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("colour is off unless stdout is a colour-capable terminal", () => {
  expect(colourLevel(pipe, {})).toBe(0);
  expect(colourLevel(tty, { NO_COLOR: "1", COLORTERM: "truecolor" })).toBe(0);
  expect(colourLevel(tty, { TERM: "dumb" })).toBe(0);
  expect(colourLevel(tty, { FORCE_COLOR: "0", COLORTERM: "truecolor" })).toBe(0);
});

test("truecolour needs COLORTERM; everything else falls back to the 256-colour cube", () => {
  expect(colourLevel(tty, { COLORTERM: "truecolor" })).toBe(2);
  expect(colourLevel(tty, { COLORTERM: "24bit" })).toBe(2);
  expect(colourLevel(tty, { TERM: "xterm-256color" })).toBe(1);
  expect(colourLevel(pipe, { FORCE_COLOR: "3" })).toBe(2);
  expect(colourLevel(pipe, { FORCE_COLOR: "1", COLORTERM: "truecolor" })).toBe(1);
});

test("stripAnsi removes ANSI escape sequences", async () => {
  const { stripAnsi, red, bold } = await import("../src/ui.ts");
  expect(stripAnsi(bold(red("Hello world")))).toBe("Hello world");
  expect(stripAnsi("plain text")).toBe("plain text");
});

test("divider renders correct length and character", async () => {
  const { divider, stripAnsi } = await import("../src/ui.ts");
  const line = divider(30);
  expect(stripAnsi(line)).toHaveLength(30);
});

test("navHint formats key navigation instructions", async () => {
  const { navHint, stripAnsi } = await import("../src/ui.ts");
  const hint = navHint([
    { key: "↑/↓", action: "Navigate" },
    { key: "enter", action: "Confirm" },
  ]);
  expect(stripAnsi(hint)).toContain("↑/↓ Navigate");
  expect(stripAnsi(hint)).toContain("enter Confirm");
});

test("button renders active and inactive states", async () => {
  const { button, stripAnsi } = await import("../src/ui.ts");
  expect(stripAnsi(button("Next", false))).toContain("[Next]");
  expect(stripAnsi(button("Next", true))).toContain("[Next]");
});

test("card formats rounded panels enclosing lines", async () => {
  const { card, stripAnsi } = await import("../src/ui.ts");
  const panel = card(["Line 1", "Line 2"], "Title", 30);
  const plain = stripAnsi(panel);
  expect(plain).toContain("Title");
  expect(plain).toContain("Line 1");
  expect(plain).toContain("Line 2");
});

