import { test, expect } from "bun:test";
import { logo, logoSmall, GRIDS, SMALL_SIZE, T } from "../src/logo.ts";

test("logo and thread exports are defined", () => {
  expect(typeof logo).toBe("function");
  expect(typeof logo()).toBe("string");
  expect(typeof T).toBe("string");
});

test("logo degrades gracefully without color", () => {
  // In bun test stdout is a pipe without FORCE_COLOR, so colourLevel is 0
  if (!process.env.FORCE_COLOR) {
    expect(logo()).toBe("");
    expect(logoSmall()).toBe("");
    expect(T).toBe("");
  }
});

test("every grid row is the same width, so no line renders short", () => {
  for (const grid of Object.values(GRIDS)) {
    for (const row of grid) expect(row.length).toBe(grid[0]!.length);
  }
});

test("both eyes are the same size and level with each other", () => {
  // The mascot's eyes are what makes it the mascot: a pupil one row lower on
  // one side reads as a squint, which is how the first pixel art went wrong.
  for (const grid of Object.values(GRIDS)) {
    const rowsWithEyes = grid.filter((row) => row.includes("o"));
    expect(rowsWithEyes.length).toBeGreaterThan(2);
    const rowsWithPupils = grid.filter((row) => row.includes("@"));
    expect(rowsWithPupils.length).toBeGreaterThan(1);
    for (const row of grid) {
      const left = row.slice(0, row.length / 2);
      const right = [...row.slice(row.length / 2)].reverse().join("");
      // Mirrored halves: each eye is drawn at the same height, the same width,
      // and the same distance from the centre as the other.
      const shape = (half: string) => [...half].map((c) => (c === "o" || c === "@" ? c : ".")).join("");
      expect(shape(left)).toBe(shape(right));
    }
  }
});

test("the pupils sit inside the eye whites", () => {
  for (const grid of Object.values(GRIDS)) {
    for (const [y, row] of grid.entries()) {
      for (const [x, token] of [...row].entries()) {
        if (token !== "@") continue;
        // A pupil touching the body means an eye leaking into the face.
        const neighbours = [grid[y - 1]?.[x], grid[y + 1]?.[x], row[x - 1], row[x + 1]];
        for (const neighbour of neighbours) expect(["o", "@", undefined]).toContain(neighbour);
      }
    }
  }
});

test("half-block rendering pairs two pixel rows per line", () => {
  const { GRIDS: grids } = require("../src/logo.ts") as typeof import("../src/logo.ts");
  expect(SMALL_SIZE.columns).toBe(grids.small[0]!.length);
  expect(SMALL_SIZE.rows).toBe(Math.ceil(grids.small.length / 2));
});
