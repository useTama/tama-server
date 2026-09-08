/**
 * When a note is talking about, as opposed to when it was captured.
 *
 * The first slice of #59. A note is a blob of transcript plus `captured:`, so
 * nothing in the system can tell you the passport expires next month: the date
 * is in the prose and the prose is only ever matched by word overlap. A second
 * brain that cannot say what is due is a search box with good manners.
 *
 * Written against the real fixture notes rather than against an idea of what a
 * note looks like, and they are not what a date parser expects:
 *
 *   "passport expires november 2026 ... takes about three weeks ... start in august"
 *   "slots open at 9am ist on the first of every month"
 *   "car service is due at 40000 km and we are at 38200"
 *   "quote was fourteen thousand"
 *
 * Three consequences, and they set the whole scope.
 *
 * **Months, not days.** Almost nothing says "15 January 2026". Real notes say
 * "november 2026" and "in august". So a month with no day is a first-class
 * result, carrying `precision: "month"`, and a reminder built on it must say
 * "November" rather than inventing the 1st. Fabricated precision is the failure
 * this whole file has to avoid: a wrong date becomes a wrong reminder, and the
 * owner cannot see where it came from.
 *
 * **A bare number is never a date.** These notes are full of 40000, 38200 and
 * spoken quantities. A day-of-month is therefore only read next to a month
 * name, never on its own, which costs "on the 15th" and buys never turning a
 * mileage into a deadline.
 *
 * **Durations and recurrences are not points in time.** "about three weeks",
 * "four minutes" and "the first of every month" all parse as tempting and none
 * of them is a date. They are deliberately not matched here; a recurrence in
 * particular needs a rule, not an instant, and guessing one instant from it
 * would be wrong eleven times out of twelve.
 *
 * Every mention carries the text that produced it, because anything surfaced
 * proactively has to quote the note rather than assert a date the owner cannot
 * trace.
 */

import type { Database } from "bun:sqlite";

export type Precision = "day" | "month";

export type Mention = {
  /** The exact substring that produced this, for quoting back. */
  text: string;
  /** Start of the period named, as a local calendar date, `YYYY-MM-DD`. */
  at: string;
  /** How much of `at` the note actually said. "month" means the day is ours. */
  precision: Precision;
};

const MONTHS: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sept: 8, sep: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const MONTH_NAMES = Object.keys(MONTHS).join("|");
const WEEKDAY_NAMES = Object.keys(WEEKDAYS).join("|");

/**
 * A year is four digits in a plausible range, never any four digits.
 *
 * "we are at 38200" is not 38200 AD, and "40000 km" is not a year. Bounding it
 * is what makes a year safe to read out of a transcript at all.
 */
const YEAR = "(19\\d\\d|20\\d\\d|21\\d\\d)";

/** `2026-01-15`. The only form where a day needs no month name beside it. */
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

/** `15 january`, `15th jan`, `1st of august`. Day first. */
const DAY_MONTH = new RegExp(
  `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES})\\b(?:\\s+${YEAR})?`,
  "gi",
);

/** `january 15`, `jan 15th 2026`. Month first. */
const MONTH_DAY = new RegExp(
  `\\b(${MONTH_NAMES})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+${YEAR})?`,
  "gi",
);

/** `november 2026`. A month and a year, no day. */
const MONTH_YEAR = new RegExp(`\\b(${MONTH_NAMES})\\s+${YEAR}\\b`, "gi");

/**
 * A bare month: `in august`, `start in august`, `by december`.
 *
 * Requires a preposition in front. Without one, "may" matches the verb in "we
 * may ship it", and "march" matches a protest. The preposition is what makes a
 * bare month name a statement about time.
 *
 * Refuses a following number, which is what keeps the patterns mutually
 * exclusive rather than leaving them to be untangled afterwards. Without it,
 * "in november 2026" matched here too and resolved to November *2025*, because
 * this pattern cannot see the year: one sentence, two mentions, one of them a
 * year wrong.
 */
const BARE_MONTH = new RegExp(
  `\\b(?:in|by|before|after|until|till|during)\\s+(${MONTH_NAMES})\\b(?!\\s+\\d)`,
  "gi",
);

/** `tomorrow`, `today`, `tonight`. */
const RELATIVE_DAY = /\b(today|tonight|tomorrow)\b/gi;

/** `monday`, `next friday`, `this tuesday`. */
const WEEKDAY = new RegExp(`\\b(?:(next|this)\\s+)?(${WEEKDAY_NAMES})\\b`, "gi");

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** A local calendar date, formatted the way the vault writes them. */
function localDate(y: number, m: number, d: number): string {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}

/** Whether `d` is a real day of `m` in `y`, so 31 february is not a date. */
function valid(y: number, m: number, d: number): boolean {
  if (m < 0 || m > 11 || d < 1 || d > 31) return false;
  const probe = new Date(y, m, d);
  return probe.getFullYear() === y && probe.getMonth() === m && probe.getDate() === d;
}

/**
 * The next occurrence of a month, at or after the anchor's own month.
 *
 * A note in January saying "start in august" means this August. The same note
 * in September means next August. Rolling forward is the only reading that
 * makes an undated month useful, and it is the one a person means: nobody
 * dictates a reminder about a month that has already gone.
 */
function nextMonth(anchor: Date, month: number): { year: number } {
  const year = anchor.getFullYear();
  return { year: month >= anchor.getMonth() ? year : year + 1 };
}

/** The next occurrence of a weekday, counting today as the nearest one. */
function nextWeekday(anchor: Date, weekday: number, force: boolean): Date {
  const out = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  let delta = (weekday - out.getDay() + 7) % 7;
  // "next friday" said on a Friday means the one coming, not the one you are
  // standing in. A bare "friday" on a Friday means today.
  if (force && delta === 0) delta = 7;
  out.setDate(out.getDate() + delta);
  return out;
}

/**
 * Every point in time the body names, resolved against when it was captured.
 *
 * `capturedAt` is the anchor because every relative expression in a transcript
 * is relative to when it was spoken, not to when it is read. Reading them
 * against the clock would make the same note mean something different tomorrow.
 *
 * Order is the order they appear in the text, and duplicates resolving to the
 * same date and precision are dropped, so a note repeating "august" twice does
 * not produce two reminders.
 */
export function mentionedDates(body: string, capturedAt: string | Date): Mention[] {
  const anchor = capturedAt instanceof Date ? capturedAt : new Date(capturedAt);
  if (!Number.isFinite(anchor.getTime())) return [];

  const found: Array<Mention & { index: number }> = [];
  const push = (m: Mention & { index: number }) => found.push(m);

  for (const match of body.matchAll(ISO)) {
    const [text, y, mo, d] = match;
    const year = Number(y), month = Number(mo) - 1, day = Number(d);
    if (!valid(year, month, day)) continue;
    push({ text, at: localDate(year, month, day), precision: "day", index: match.index });
  }

  for (const re of [DAY_MONTH, MONTH_DAY]) {
    for (const match of body.matchAll(re)) {
      const dayFirst = re === DAY_MONTH;
      const day = Number(dayFirst ? match[1] : match[2]);
      const monthWord = (dayFirst ? match[2] : match[1])!.toLowerCase();
      const month = MONTHS[monthWord]!;
      // An explicit year wins; otherwise the same roll-forward a bare month
      // gets, since "15 august" in January means this year's August.
      const year = match[3] ? Number(match[3]) : nextMonth(anchor, month).year;
      if (!valid(year, month, day)) continue;
      push({ text: match[0], at: localDate(year, month, day), precision: "day", index: match.index });
    }
  }

  for (const match of body.matchAll(MONTH_YEAR)) {
    const month = MONTHS[match[1]!.toLowerCase()]!;
    push({
      text: match[0],
      at: localDate(Number(match[2]), month, 1),
      precision: "month",
      index: match.index,
    });
  }

  for (const match of body.matchAll(BARE_MONTH)) {
    const month = MONTHS[match[1]!.toLowerCase()]!;
    push({
      text: match[0],
      at: localDate(nextMonth(anchor, month).year, month, 1),
      precision: "month",
      index: match.index,
    });
  }

  for (const match of body.matchAll(RELATIVE_DAY)) {
    const word = match[1]!.toLowerCase();
    const at = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    if (word === "tomorrow") at.setDate(at.getDate() + 1);
    push({
      text: match[0],
      at: localDate(at.getFullYear(), at.getMonth(), at.getDate()),
      precision: "day",
      index: match.index,
    });
  }

  for (const match of body.matchAll(WEEKDAY)) {
    const weekday = WEEKDAYS[match[2]!.toLowerCase()]!;
    const at = nextWeekday(anchor, weekday, match[1]?.toLowerCase() === "next");
    push({
      text: match[0],
      at: localDate(at.getFullYear(), at.getMonth(), at.getDate()),
      precision: "day",
      index: match.index,
    });
  }

  // Resolved most-informative-first, then put back into reading order.
  //
  // Longest text wins, because a longer match read more of the sentence:
  // "november 2026" knows the year that "in november" cannot see. Sorting by
  // position instead would let whichever pattern happened to start a character
  // earlier win, which is how one sentence became two mentions a year apart.
  // Precision breaks a tie, since a day the note actually stated beats a month.
  found.sort((a, b) =>
    b.text.length !== a.text.length
      ? b.text.length - a.text.length
      : a.precision === b.precision
        ? a.index - b.index
        : a.precision === "day" ? -1 : 1,
  );

  const accepted: Array<Mention & { index: number }> = [];
  const seen = new Set<string>();
  for (const m of found) {
    const end = m.index + m.text.length;
    // Any overlap, not just containment. Two patterns reading the same phrase
    // from different starting points overlap without either containing the
    // other, and both describe one thing the owner said once.
    if (accepted.some((a) => m.index < a.index + a.text.length && a.index < end)) continue;
    const key = `${m.at}/${m.precision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(m);
  }

  return accepted
    .sort((a, b) => a.index - b.index)
    .map(({ text, at, precision }) => ({ text, at, precision }));
}

/** One mention, attached to the note that said it. */
export type NoteDate = Mention & { notePath: string };

/**
 * Replace what is known about one note's dates.
 *
 * Delete-then-insert rather than upsert, so re-reading a note after the
 * extractor improves does not leave yesterday's wrong guesses behind. The table
 * is derived; the note is the truth.
 */
export function recordDates(db: Database, notePath: string, mentions: Mention[]): void {
  db.transaction(() => {
    db.query("DELETE FROM note_dates WHERE note_path = ?").run(notePath);
    const insert = db.query(
      "INSERT OR REPLACE INTO note_dates (note_path, at, precision, text) VALUES (?, ?, ?, ?)",
    );
    for (const m of mentions) insert.run(notePath, m.at, m.precision, m.text);
  })();
}

/**
 * What the notes say is coming, between `from` and `days` later inclusive.
 *
 * Dates are compared as local `YYYY-MM-DD` strings, which sorts and ranges
 * correctly and avoids reintroducing a timezone at the one place the whole
 * point is what day it is where the owner is.
 */
export function upcomingDates(db: Database, from: Date, days: number): NoteDate[] {
  const start = localDate(from.getFullYear(), from.getMonth(), from.getDate());
  const until = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  const end = localDate(until.getFullYear(), until.getMonth(), until.getDate());
  return db
    .query(
      `SELECT note_path AS notePath, at, precision, text FROM note_dates
       WHERE at >= ? AND at <= ? ORDER BY at, note_path`,
    )
    .all(start, end) as NoteDate[];
}

const MONTH_LABELS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * How a mention is allowed to be shown.
 *
 * A month-precision mention must never render as a day. "November 2026" is
 * what the note said; "1 November 2026" is a date this code made up, and a
 * reminder that states it would be asserting precision the owner never gave.
 */
export function describe(m: Mention): string {
  const [y, mo, d] = m.at.split("-");
  const month = MONTH_LABELS[Number(mo) - 1] ?? mo;
  return m.precision === "month" ? `${month} ${y}` : `${Number(d)} ${month} ${y}`;
}
