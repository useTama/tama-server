/**
 * Terminal colour for the setup wizard and the server banner.
 *
 * One accent — the Tama red from the app icon — plus the status colours the
 * architecture diagrams already use, so the CLI and the docs look like the
 * same product. Colour is decoration and never carries meaning on its own:
 * every line stays readable when it is stripped, which is what NO_COLOR, a
 * dumb terminal, and a redirected stdout all do.
 */

/** 0 none, 1 the 256-colour cube, 2 24-bit truecolour. Exported so it can be tested without a terminal. */
export function colourLevel(stream: { isTTY?: boolean }, env: Record<string, string | undefined> = process.env): 0 | 1 | 2 {
  const forced = env.FORCE_COLOR;
  if (env.NO_COLOR || env.TERM === "dumb" || forced === "0") return 0;
  if (forced === "1" || forced === "2") return 1;
  if (forced === "3") return 2;
  if (forced === undefined && !stream.isTTY) return 0;
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") ? 2 : 1;
}

const LEVEL = colourLevel(process.stdout);

/** `rgb` is the icon/diagram colour; `xterm` is its nearest 256-colour cube index. */
function paint(rgb: string, xterm: number): (text: string) => string {
  if (LEVEL === 0) return (text) => text;
  const open = LEVEL === 2 ? `\x1b[38;2;${rgb}m` : `\x1b[38;5;${xterm}m`;
  return (text) => `${open}${text}\x1b[39m`;
}

export const red = paint("240;78;60", 203);      // #f04e3c — icon, the accent
export const orange = paint("249;164;78", 215);  // #f9a44e — icon gradient, top
export const green = paint("63;185;80", 71);     // #3fb950 — diagram "ok"
export const amber = paint("210;153;34", 178);   // #d29922 — diagram "attention"
export const grey = paint("139;148;158", 245);   // #8b949e — diagram labels

export const bold = (text: string): string => (LEVEL === 0 ? text : `\x1b[1m${text}\x1b[22m`);

/** The wordmark. Bold red on its own, so it reads as a heading without a rule. */
export const tama = (text = "Tama"): string => bold(red(text));

export const ok = (text: string): string => `${green("✓")} ${text}`;
export const warn = (text: string): string => `${amber("⚠")} ${text}`;
export const fail = (text: string): string => `${red("✗")} ${text}`;

export const dim = (text: string): string => (LEVEL === 0 ? text : `\x1b[2m${text}\x1b[22m`);
export const inverse = (text: string): string => (LEVEL === 0 ? text : `\x1b[7m${text}\x1b[27m`);

/** Strips ANSI escape codes to measure rendered string width in columns. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/**
 * Cuts a string to a visible width, keeping its colour codes.
 *
 * Counting bytes would cut a coloured string far too early and could stop
 * halfway through an escape sequence, which leaves the rest of the terminal
 * painted, so the escapes are stepped over rather than measured, and a reset is
 * appended when the cut lands inside one.
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (stripAnsi(text).length <= width) return text;
  let out = "";
  let visible = 0;
  let coloured = false;
  for (const part of text.split(/(\x1b\[[0-9;]*[a-zA-Z])/)) {
    if (part.startsWith("\x1b")) { out += part; coloured = true; continue; }
    for (const character of part) {
      if (visible >= width - 1) return `${out}…${coloured ? "\x1b[0m" : ""}`;
      out += character;
      visible += 1;
    }
  }
  return out;
}

/** Horizontal divider rule in muted grey or plain ASCII. */
export function divider(length = 56): string {
  return LEVEL === 0 ? "-".repeat(length) : grey("─".repeat(length));
}

/**
 * The width every box, rule and footer lays out to.
 *
 * Capped at 72 rather than filling the window: a card stretched across a
 * 200-column terminal is a line of text with two distant borders, and the eye
 * loses which row it is on. Floored at 40 so a narrow window shrinks the box
 * instead of wrapping it.
 */
export function layoutWidth(): number {
  return Math.max(40, Math.min(72, (process.stdout.columns ?? 80) - 4));
}

/**
 * Keybindings hint line shown at the bottom of interactive steps
 * (e.g. `↑/↓ Navigate  ·  enter Confirm`).
 */
export function navHint(hints: Array<{ key: string; action: string }>): string {
  const bullet = LEVEL === 0 ? "·" : grey("·");
  return hints
    .map(({ key, action }) => `${LEVEL === 0 ? key : bold(red(key))} ${LEVEL === 0 ? action : grey(action)}`)
    .join(`  ${bullet}  `);
}

/**
 * Renders a button badge, e.g. `[ Next ]` or `[ Done ]`.
 * When active, it uses red styling so it pops prominently.
 */
export function button(label: string, active = false): string {
  if (LEVEL === 0) return active ? `[${label}]*` : `[${label}]`;
  return active ? bold(red(`[${label}]`)) : grey(`[${label}]`);
}

/**
 * Formats a block of lines inside a rounded card panel.
 * Uses UTF-8 box drawing characters with rounded corners (or ASCII fallback).
 */
export function card(lines: string[], title?: string, width = 56, indent = 0): string {
  const padLeft = " ".repeat(indent);
  // `width` is a minimum, and the content stretches it — but only as far as the
  // layout, because a box wider than the window wraps and every border lands in
  // the wrong place. A long vault path gets an ellipsis instead.
  const minWidth = Math.min(
    Math.max(width, title ? stripAnsi(title).length + 8 : 0, ...lines.map((l) => stripAnsi(l).length + 4)),
    Math.max(24, layoutWidth() - 2),
  );
  const rowLines = lines.map((l) => truncate(l, minWidth - 2));

  if (LEVEL === 0) {
    // `+-- Title ` is six characters plus the title, and the box is minWidth+2
    // wide like every row below it, so the filler is what is left of that.
    const top = padLeft + (title ? `+-- ${title} ${"-".repeat(Math.max(0, minWidth - stripAnsi(title).length - 4))}+` : `+${"-".repeat(minWidth)}+`);
    const rows = rowLines.map((l) => {
      const pad = Math.max(0, minWidth - stripAnsi(l).length - 2);
      return `${padLeft}| ${l}${" ".repeat(pad)} |`;
    });
    const bottom = `${padLeft}+${"-".repeat(minWidth)}+`;
    return [top, ...rows, bottom].join("\n");
  }

  const border = grey;
  const topTitle = title ? `─ ${bold(title)} ` : "─";
  const topFiller = Math.max(0, minWidth - stripAnsi(topTitle).length);
  const top = `${padLeft}${border(`╭${topTitle}${"─".repeat(topFiller)}╮`)}`;
  const rows = rowLines.map((l) => {
    const pad = Math.max(0, minWidth - stripAnsi(l).length - 2);
    return `${padLeft}${border("│")} ${l}${" ".repeat(pad)} ${border("│")}`;
  });
  const bottom = `${padLeft}${border(`╰${"─".repeat(minWidth)}╯`)}`;
  return [top, ...rows, bottom].join("\n");
}

/**
 * Text from somewhere else, made safe to print next to something a human acts on.
 *
 * Most strings this file styles are ours. A few are not: an OAuth token's
 * device name comes from the client's own metadata document, so it is written
 * by whoever is asking for access and then printed into the owner's terminal -
 * in the Credentials list, directly above the prompt where they type an id to
 * revoke one.
 *
 * A terminal is not a text box. Left alone, an escape sequence in that name can
 * move the cursor, clear the line and rewrite what was printed before it, which
 * means one credential's line can be made to display another's id. The reader
 * would then revoke the wrong token and believe they had revoked the right one.
 *
 * So: no C0 or C1 controls (which is where ESC lives, so no escape sequences),
 * no line breaks, and a width cap - because a name long enough to wrap achieves
 * most of the same effect without needing a control character at all.
 */
export function displayName(raw: string, max = 48): string {
  const flattened = raw
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flattened) return "(unnamed)";
  return flattened.length > max ? `${flattened.slice(0, max - 1)}…` : flattened;
}
