/**
 * The setup wizard's page frame.
 *
 * The wizard used to be one long scroll: by the time you were choosing a
 * transcription model, the vault path had left the screen and there was nothing
 * to say how much was left. This draws each step as its own page — mascot and
 * step rail at the top, one question set in the middle, keys and status at the
 * bottom — so the answer to "where am I and how do I go back" is always on
 * screen.
 *
 * Two rules hold everywhere in here. Colour never carries meaning on its own,
 * so the rail marks the step you are on with `▸` and finished ones with `✓`
 * rather than with colour alone. And nothing assumes a size: the frame measures
 * `process.stdout.columns` and shrinks, because a wizard that wraps its own
 * footer looks broken.
 */

import { stdout as output } from "node:process";
import { bold, dim, divider, green, grey, layoutWidth, navHint, red, stripAnsi, tama } from "./ui.ts";
import { logoSmall } from "./logo.ts";

/** One page of the wizard. `blurb` is the sentence under the title. */
export type Step = { key: string; title: string; blurb: string };

/** The frame's own width: the same one every card and rule in the CLI uses. */
export const frameWidth = layoutWidth;

/**
 * `logoSmall()` is 16 columns wide and the gutter is 3, so this is where the
 * text beside the mascot starts — and how much of it there is room for.
 */
const MASCOT_COLUMNS = 19;
function bodyWidth(): number {
  return Math.max(28, Math.min(frameWidth(), (output.columns ?? 80) - MASCOT_COLUMNS - 2));
}

/**
 * Greedy word wrap. The header text is written for the page rather than for a
 * width, so it is folded here instead of being cut off with an ellipsis: a
 * blurb that explains what a page is for is not worth losing half of.
 */
export function wrap(text: string, width: number): string[] {
  const words = stripAnsi(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line.length > 0) lines.push(line);
  return lines.length > 0 ? lines : [""];
}

/**
 * Joins two blocks side by side, padding the left one to its widest visible
 * line. Measuring with `stripAnsi` is the whole trick: a coloured line is
 * longer in bytes than it is on screen.
 */
export function columns(left: string, right: string, gutter = 3): string {
  const leftLines = left.length > 0 ? left.split("\n") : [];
  const rightLines = right.split("\n");
  const width = Math.max(0, ...leftLines.map((line) => stripAnsi(line).length));
  const rows = Math.max(leftLines.length, rightLines.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = leftLines[i] ?? "";
    const r = rightLines[i] ?? "";
    const pad = " ".repeat(Math.max(0, width - stripAnsi(l).length) + (width > 0 ? gutter : 0));
    out.push(`${l}${pad}${r}`.trimEnd());
  }
  return out.join("\n");
}

/**
 * `✓ World  ▸ Vault  · Voice` — where you are in the wizard, and how much of it
 * is left. Steps a scoped run skips are never in the list it is given, so the
 * count never promises a page that will not appear.
 */
export function rail(steps: Step[], current: number): string {
  const marks = steps.map((step, i) => {
    if (i < current) return `${green("✓")} ${grey(step.title)}`;
    if (i === current) return `${red("▸")} ${bold(step.title)}`;
    return `${dim("·")} ${dim(step.title)}`;
  });
  // One line if it fits; otherwise the current step alone, because a wrapped
  // rail is worse than no rail.
  const line = marks.join("  ");
  return stripAnsi(line).length <= bodyWidth() ? line : marks[current]!;
}

/**
 * Clears the page. `\x1b[2J` only clears the visible screen: the scrollback
 * above it is the user's, and a wizard has no business deleting it.
 */
function clear(): void {
  if (output.isTTY) output.write("\x1b[2J\x1b[H");
  else output.write("\n\n");
}

/**
 * Draws the frame for one step: mascot on the left, and beside it the wordmark,
 * the rail, and what this page is for. Everything sits in the mascot's own eight
 * lines, so the questions below always start at the same row.
 */
export function page(steps: Step[], current: number, subtitle?: string): void {
  const step = steps[current]!;
  frame([
    rail(steps, current),
    "",
    `${bold(`Step ${current + 1} of ${steps.length}`)}${grey(` · ${step.title}`)}`,
    ...wrap(step.blurb, bodyWidth()).map(grey),
    ...(subtitle ? wrap(subtitle, bodyWidth()).map(grey) : []),
  ]);
}

/**
 * Draws the frame for a page that is not one of the numbered steps — the
 * welcome page and the one that reports what was saved.
 */
export function coverPage(title: string, blurb: string): void {
  frame(["", bold(title), ...wrap(blurb, bodyWidth()).map(grey)]);
}

function frame(body: string[]): void {
  clear();
  const heading = [
    `${tama("Tama")} ${grey("setup")}`,
    grey("Voice notes in a Markdown folder you own."),
    ...body,
  ];
  // With colour off there is no mascot to sit beside, so the heading takes the
  // two-space indent everything else on the page uses rather than hugging the
  // left edge on its own.
  const mascot = logoSmall();
  console.log(mascot ? columns(mascot, heading.join("\n")) : heading.map((line) => `  ${line}`).join("\n"));
  console.log(`  ${divider(frameWidth())}\n`);
}

/**
 * The bottom line: keys on the left, where-you-are on the right, right-aligned
 * to the frame. It is printed rather than pinned to the last row, because the
 * questions above it can grow and a pinned footer would be overwritten by them.
 */
export function footer(hints: Array<{ key: string; action: string }>, status?: string): string {
  const left = `  ${navHint(hints)}`;
  if (!status) return left;
  const right = grey(status);
  const room = frameWidth() + 2 - stripAnsi(left).length - stripAnsi(right).length;
  return room > 2 ? `${left}${" ".repeat(room)}${right}` : `${left}\n  ${right}`;
}
