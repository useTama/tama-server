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
