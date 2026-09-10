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

test("truncate cuts to a visible width and keeps escape codes intact", async () => {
  const { truncate, stripAnsi, red } = await import("../src/ui.ts");
  expect(truncate("abcdefghij", 5)).toBe("abcd…");
  expect(truncate("abc", 5)).toBe("abc");
  expect(stripAnsi(truncate(red("abcdefghij"), 5))).toBe("abcd…");
  // A cut inside a coloured run has to close it, or the rest of the terminal
  // stays painted.
  if (process.env.FORCE_COLOR) expect(truncate(red("abcdefghij"), 5)).toEndWith("\x1b[0m");
});

test("card never draws wider than the layout, and every border lines up", async () => {
  const { card, stripAnsi, layoutWidth } = await import("../src/ui.ts");
  const long = "x".repeat(400);
  const rendered = card([long, "short"], "Title", 56, 2).split("\n");
  const widths = new Set(rendered.map((line) => stripAnsi(line).length));
  expect(widths.size).toBe(1);
  expect([...widths][0]!).toBeLessThanOrEqual(layoutWidth() + 2);
  expect(stripAnsi(card([long], undefined, 56)).includes("…")).toBe(true);
});
