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

/** Horizontal divider rule in muted grey or plain ASCII. */
export function divider(length = 56): string {
  return LEVEL === 0 ? "-".repeat(length) : grey("─".repeat(length));
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
  const minWidth = Math.max(
    width,
    title ? stripAnsi(title).length + 8 : 0,
    ...lines.map((l) => stripAnsi(l).length + 4),
  );

  if (LEVEL === 0) {
    const top = padLeft + (title ? `+-- ${title} ${"-".repeat(Math.max(0, minWidth - stripAnsi(title).length - 6))}+` : `+${"-".repeat(minWidth)}+`);
    const rows = lines.map((l) => {
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
  const rows = lines.map((l) => {
    const pad = Math.max(0, minWidth - stripAnsi(l).length - 2);
    return `${padLeft}${border("│")} ${l}${" ".repeat(pad)} ${border("│")}`;
  });
  const bottom = `${padLeft}${border(`╰${"─".repeat(minWidth)}╯`)}`;
  return [top, ...rows, bottom].join("\n");
}
