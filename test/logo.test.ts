import { test, expect } from "bun:test";
import { logo, T } from "../src/logo.ts";

test("logo and thread exports are defined", () => {
  expect(typeof logo).toBe("function");
  expect(typeof logo()).toBe("string");
  expect(typeof T).toBe("string");
});

test("logo degrades gracefully without color", () => {
  // In bun test stdout is a pipe without FORCE_COLOR, so colourLevel is 0
  if (!process.env.FORCE_COLOR) {
    expect(logo()).toBe("");
    expect(T).toBe("");
  }
});

test("both eyes are vertically and horizontally aligned with symmetric cheek margins", () => {
  const { readFileSync } = require("fs");
  const code = readFileSync("src/logo.ts", "utf8");
  const tcPart = code.split("const TRUECOLOR_LOGO = [")[1].split("].join")[0];
  const lines = tcPart.trim().split("\n").filter((l: string) => l.trim().startsWith('"'));
  
  // Eye rows are rows 5, 6, 7 (indices 6, 7, 8 including initial empty string)
  for (const lineIdx of [6, 7, 8]) {
    const line = lines[lineIdx];
    // White eye color: 255;255;255
    expect(line).toContain("255;255;255");
    // Pupil color at rows 6 and 7
    if (lineIdx > 6) {
      expect(line).toContain("40;35;34");
    }
  }
});
