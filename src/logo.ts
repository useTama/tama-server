/**
 * The Tama mascot as terminal pixel art, traced from assets/icon.png.
 *
 * Two decisions make it read as the icon rather than as an orange ball.
 *
 * The first is half-block characters. A terminal cell is about twice as tall as
 * it is wide, so the obvious way to get square pixels — two spaces per pixel —
 * throws away half the vertical resolution. `▀` with a foreground colour for
 * its top half and a background colour for its bottom half fits two pixels in
 * one cell, which is what buys the cloud lobes and the round pupils the logo is
 * actually recognised by. The previous art had neither: it was a smooth blob
 * with two black bars for eyes.
 *
 * The second is storing the art as a grid of tokens rather than as escape
 * codes. The gradient is computed from a pixel's position, so a colour is
 * defined once instead of once per pixel, and the shape stays editable: these
 * are pictures you can read in the source and change by typing.
 *
 * Nothing is drawn at all when colour is off (LEVEL === 0). Colour is the whole
 * content of a logo, and a mascot spelled in `#` would be noise in a log.
 */

import { colourLevel, red } from "./ui.ts";

const LEVEL = colourLevel(process.stdout);

/**
 * `#` body, `o` eye white, `@` pupil, `.` nothing. Rows are pixels, not lines:
 * two of them share one terminal line.
 */
const FULL = [
  "..........#####..#####..........",
  "........################........",
  ".......##################.......",
  "......####################......",
  "......####################......",
  "......####################......",
  "...##########################...",
  "..############################..",
  ".##############################.",
  ".##############################.",
  "##########ooo######ooo##########",
  "#########ooooo####ooooo#########",
  "########ooooooo##ooooooo########",
  "########oo@@ooo##ooo@@oo########",
  "########oo@@@oo##oo@@@oo########",
  ".#######o@@@@oo##oo@@@@o#######.",
  ".#######o@@@@oo##oo@@@@o#######.",
  "#########o@@oo####oo@@o#########",
  "##########ooo######ooo##########",
  "################################",
  "################################",
  "################################",
  ".##############################.",
  ".##############################.",
  "..############################..",
  "...##########################...",
  "......####################......",
  "......####################......",
  "......####################......",
  ".......##################.......",
  "........################........",
  "..........#####..#####..........",
];

/**
 * The same face at half the size, for headers that share their line with text.
 * Hand-drawn rather than downsampled: the cloud lobes and the pupil highlight
 * turn to mush at 16 pixels, and a clean round face reads as the mascot where a
 * blurred accurate one reads as a smudge.
 */
const SMALL = [
  "....########....",
  "..############..",
  ".##############.",
  "################",
  "################",
  "###oooo##oooo###",
  "###oooo##oooo###",
  "###o@@o##o@@o###",
  "###o@@o##o@@o###",
  "###oooo##oooo###",
  "################",
  "################",
  "################",
  ".##############.",
  "..############..",
  "....########....",
];

type Rgb = [number, number, number];

// Sampled from the icon's two extremes. ui.ts's `orange` and `red` are the
// text-weight versions of the same pair; these are the picture's own, because
// the art is what the gradient is for.
const GRADIENT_TOP: Rgb = [255, 190, 104];
const GRADIENT_BOTTOM: Rgb = [232, 62, 56];
const EYE_WHITE: Rgb = [255, 250, 244];
const PUPIL: Rgb = [58, 50, 48];

/** Nearest index in the 6×6×6 cube, for terminals without truecolour. */
function cube([r, g, b]: Rgb): number {
  const q = (c: number) => Math.round((c / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function colourAt(grid: string[], x: number, y: number): Rgb | undefined {
  const token = grid[y]?.[x];
  if (token === undefined || token === ".") return undefined;
  if (token === "o") return EYE_WHITE;
  if (token === "@") return PUPIL;
  // The icon's gradient runs corner to corner, so the mix is the average of how
  // far across and how far down the pixel is.
  const width = grid[0]!.length - 1;
  const height = grid.length - 1;
  const t = (x / width + y / height) / 2;
  return GRADIENT_TOP.map((c, i) => Math.round(c + (GRADIENT_BOTTOM[i]! - c) * t)) as Rgb;
}

/**
 * One character per pixel column, one per two pixel rows. The half-block never
 * paints a cell whose pixels are both empty, so the art composites onto whatever
 * background the terminal has rather than stamping a black rectangle on it.
 */
function render(grid: string[], indent: number): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (let row = 0; row < grid.length; row += 2) {
    let line = pad;
    for (let x = 0; x < grid[0]!.length; x++) {
      const top = colourAt(grid, x, row);
      const bottom = colourAt(grid, x, row + 1);
      if (!top && !bottom) { line += " "; continue; }
      const fg = (c: Rgb) => (LEVEL === 2 ? `\x1b[38;2;${c.join(";")}m` : `\x1b[38;5;${cube(c)}m`);
      const bg = (c: Rgb) => (LEVEL === 2 ? `\x1b[48;2;${c.join(";")}m` : `\x1b[48;5;${cube(c)}m`);
      // "▀" is the top half, so an empty top half is drawn as "▄" instead of as
      // a background colour: a background would fill the cell's other half too.
      if (top && bottom) line += `${fg(top)}${bg(bottom)}▀\x1b[39;49m`;
      else if (top) line += `${fg(top)}▀\x1b[39m`;
      else line += `${fg(bottom!)}▄\x1b[39m`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

/** The mascot, with the blank lines above and below that a banner wants. */
export function logo(): string {
  if (LEVEL === 0) return "";
  return `\n${render(FULL, 2)}\n`;
}

/** The mascot at header size, without surrounding blank lines. */
export function logoSmall(): string {
  if (LEVEL === 0) return "";
  return render(SMALL, 0);
}

/** How many lines and columns `logoSmall()` occupies, for laying out beside it. */
export const SMALL_SIZE = { rows: Math.ceil(SMALL.length / 2), columns: SMALL[0]!.length };

/** Exported for the test that keeps the two eyes the same size and level. */
export const GRIDS = { full: FULL, small: SMALL };

export const T = LEVEL === 0 ? "" : ` ${red("▐")} `;
