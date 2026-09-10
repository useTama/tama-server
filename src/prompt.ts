/**
 * The wizard's terminal prompts, shared with `tama-server settings`.
 *
 * Extracted verbatim from setup.ts rather than rewritten: these are the exact
 * prompts users have already been answering, and a settings menu that looked
 * or behaved differently from first-run setup would be a second interface to
 * learn rather than the same one, reached later.
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { red, grey, bold, warn, ok, navHint, button } from "./ui.ts";
import { footer } from "./screen.ts";

/** Every prompt needs a terminal; none of them degrade to a non-interactive mode. */
export function requireTty(what: string): void {
  if (!input.isTTY || !output.isTTY) throw new Error(`tama ${what} needs an interactive terminal`);
}

export const ask = async (label: string, fallback: string) => {
  const rl = createInterface({ input, output });
  try {
    const hint = fallback ? grey(` [${fallback}]`) : "";
    return (await rl.question(`  ${red("›")} ${bold(label)}${hint}: `)).trim() || fallback;
  }
  finally { rl.close(); }
};

export const secret = async (label: string): Promise<string> => {
  // The label carries its own "or Enter to ..." where one applies, so only the
  // hidden-input note is added here. "Enter to skip" on a prompt that already
  // has a saved value reads as "and then it will not work".
  const hint = /enter to/i.test(label) ? " (hidden)" : " (hidden; Enter to skip)";
  output.write(`  ${red("›")} ${bold(label)}${grey(hint)}: `);
  return new Promise((done, fail) => {
    let value = "";
    const wasRaw = input.isRaw;
    const finish = (cancelled = false) => {
      input.off("data", onData); input.setRawMode(wasRaw); input.pause(); output.write("\n");
      if (cancelled) fail(new Error("Setup cancelled")); else done(value.trim());
    };
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString()) {
        if (char === "\u0003") return finish(true);
        if (char === "\r" || char === "\n") return finish();
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    input.setRawMode(true); input.on("data", onData); input.resume();
  });
};

export const endpoint = async (label: string, fallback: string): Promise<string> => {
  for (;;) {
    const value = await ask(label, fallback);
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      return value.replace(/\/+$/, "");
    } catch { console.log(warn("Enter an http:// or https:// server address without credentials or query parameters.")); }
  }
};

export const optionalPublicOrigin = async (fallback?: string): Promise<string | undefined> => {
  for (;;) {
    const value = await ask("Public HTTPS base URL (Enter to configure later)", fallback ?? "");
    if (!value) return undefined;
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
      return url.origin;
    } catch { console.log(warn("Enter an https:// origin such as https://tama.example.com, with no path or credentials.")); }
  }
};

export const choose = async <T extends string>(label: string, options: Array<{ value: T; label: string }>, fallback: T): Promise<T> => {
  let selected = options.findIndex((o) => o.value === fallback);
  if (selected < 0) selected = 0;

  console.log(`\n  ${bold(label)}:`);
  let drawnLines = 0;

  const draw = () => {
    if (drawnLines > 0) {
      output.write(`\x1b[${drawnLines}A`);
    }
    const lines: string[] = [];
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      const chosen = i === selected;
      const cursor = chosen ? red(">") : " ";
      const text = chosen ? bold(option.label) : grey(option.label);
      lines.push(`\r\x1b[2K    ${cursor} ${text}`);
    }
    lines.push(`\r\x1b[2K`);
    lines.push(`\r\x1b[2K    ${navHint([{ key: "↑/↓", action: "Navigate" }, { key: "enter", action: "Confirm" }])}`);
    output.write(lines.join("\n") + "\n");
    drawnLines = lines.length;
  };

  draw();

  return await new Promise<T>((done, fail) => {
    input.setRawMode(true);
    input.resume();
    const finish = (value?: T, error?: Error) => {
      input.setRawMode(false);
      input.off("data", onKey);
      input.pause();
      if (drawnLines > 0) {
        output.write(`\x1b[${drawnLines}A\x1b[0J`);
      }
      if (error) {
        output.write("\n");
        fail(error);
      } else {
        output.write(`  ${ok(`${label}: ${bold(options[selected]!.label)}`)}\n\n`);
        done(value!);
      }
    };
    const onKey = (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "\u0003") return finish(undefined, new Error("setup cancelled"));
      if (key === "\r" || key === "\n") return finish(options[selected]!.value);
      if (key === "\x1b[A" || key === "k") selected = (selected + options.length - 1) % options.length;
      else if (key === "\x1b[B" || key === "j") selected = (selected + 1) % options.length;
      else if (/^[1-9]$/.test(key) && Number(key) <= options.length) selected = Number(key) - 1;
      else return;
      draw();
    };
    input.on("data", onKey);
  });
};

/**
 * The page footer of a multi-page wizard: `[ Back ]  [ Next ]`, moved through
 * with the left and right arrows and confirmed with Enter.
 *
 * Enter alone always means "carry on", because that is what a wizard is mostly
 * answered with. Back is what makes the pages pages rather than a scroll — a
 * step you can return to is a step you can afford to answer wrongly — so it is
 * only offered when there is somewhere to go back to, and `esc` is a shortcut
 * for it rather than a way out of setup.
 */
export const navigate = async (
  options: { back?: boolean; next?: string; status?: string } = {},
): Promise<"back" | "next"> => {
  const nextLabel = options.next ?? "Next";
  if (!options.back) {
    // Nothing to go back to, so there is nothing to choose between: this is a
    // "press Enter" line, and drawing two buttons with one of them dead would
    // be a menu that lies about having a second option.
    const rl = createInterface({ input, output });
    try {
      await rl.question(`  ${button(nextLabel, true)}  ${grey("— press Enter to continue")}`);
      output.write("\n");
      return "next";
    } finally { rl.close(); }
  }

  let onNext = true;
  let drawn = 0;
  const draw = () => {
    if (drawn > 0) output.write(`\x1b[${drawn}A`);
    const row = `  ${button("Back", !onNext)}   ${button(nextLabel, onNext)}`;
    const hints = footer([
      { key: "←/→", action: "Move" },
      { key: "enter", action: "Confirm" },
    ], options.status);
    const lines = [`\r\x1b[2K${row}`, "\r\x1b[2K", `\r\x1b[2K${hints}`];
    output.write(`${lines.join("\n")}\n`);
    drawn = lines.length;
  };
  draw();

  return await new Promise((done, fail) => {
    input.setRawMode(true);
    input.resume();
    const finish = (value?: "back" | "next", error?: Error) => {
      input.setRawMode(false);
      input.off("data", onKey);
      input.pause();
      if (drawn > 0) output.write(`\x1b[${drawn}A\x1b[0J`);
      if (error) { output.write("\n"); fail(error); } else done(value!);
    };
    const onKey = (chunk: Buffer) => {
      const key = chunk.toString();
      if (key === "\u0003") return finish(undefined, new Error("setup cancelled"));
      if (key === "\r" || key === "\n") return finish(onNext ? "next" : "back");
      if (key === "\x1b") return finish("back");
      if (key === "\x1b[D" || key === "h") onNext = false;
      else if (key === "\x1b[C" || key === "l") onNext = true;
      else if (key === "\t") onNext = !onNext;
      else return;
      draw();
    };
    input.on("data", onKey);
  });
};

export const yes = async (label: string, fallback = false) => {
  const answer = (await ask(`${label} ${fallback ? grey("[Y/n]") : grey("[y/N]")}`, "")).toLowerCase();
  return answer ? answer === "y" || answer === "yes" : fallback;
};

