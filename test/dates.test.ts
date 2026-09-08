import { expect, test } from "bun:test";
import { mentionedDates } from "../src/dates.ts";

const JAN14 = "2025-01-14T06:55:20+05:30";
const at = (body: string, anchor = JAN14) => mentionedDates(body, anchor);
const dates = (body: string, anchor = JAN14) => at(body, anchor).map((m) => m.at);

// ---- the real notes this was written against ---------------------------

test("a month and year is a month, not an invented first of the month", () => {
  // "passport expires november 2026", captured 2025-01-14. The note never said
  // a day, so claiming one would be a reminder the owner cannot trace.
  const got = at("passport expires november 2026, renewal needs a police verification");
  expect(got).toHaveLength(1);
  expect(got[0]).toEqual({ text: "november 2026", at: "2026-11-01", precision: "month" });
});

test("a bare month rolls forward, because nobody sets a reminder for a month gone by", () => {
  // "start in august" said in January means this August.
  expect(dates("that takes about three weeks so start in august")).toEqual(["2025-08-01"]);
  // Said in September, it means next year's.
  expect(dates("start in august", "2025-09-20T10:00:00+05:30")).toEqual(["2026-08-01"]);
});

test("mileage is not a date", () => {
  // "car service is due at 40000 km and we are at 38200". Every number here is
  // confusable with a year or a day, which is why a day is only ever read next
  // to a month name.
  expect(at("car service is due at 40000 km and we are at 38200, brake pads marginal")).toEqual([]);
});

test("a duration is not a point in time", () => {
  expect(at("takes about three weeks to get in bangalore")).toEqual([]);
  expect(at("they are gone in about four minutes, set an alarm")).toEqual([]);
});

test("a recurrence is not a single date", () => {
  // "slots open at 9am ist on the first of every month" is a rule. Guessing one
  // instant from it would be wrong eleven times out of twelve.
  expect(at("the schengen appointment slots open at 9am ist on the first of every month")).toEqual([]);
});

test("a spoken quantity is not a date", () => {
  expect(at("quote was fourteen thousand, getting a second opinion")).toEqual([]);
});

// ---- the forms that do resolve -----------------------------------------

test("explicit days resolve, in either order, with or without a year", () => {
  expect(dates("the appointment is 15 august")).toEqual(["2025-08-15"]);
  expect(dates("the appointment is january 20th")).toEqual(["2025-01-20"]);
  expect(dates("due 1st of march 2027")).toEqual(["2027-03-01"]);
  expect(dates("shipped 2026-03-09 finally")).toEqual(["2026-03-09"]);
});

test("an impossible day is not reported as a date", () => {
  expect(at("31 february is not a day")).toEqual([]);
  expect(at("2025-02-30 came off a broken exporter")).toEqual([]);
});

test("relative days anchor to when it was said, not when it is read", () => {
  // The same note must not mean something different tomorrow.
  expect(dates("dentist tomorrow morning")).toEqual(["2025-01-15"]);
  expect(dates("shipping tonight")).toEqual(["2025-01-14"]);
});

test("next friday is the one coming, a bare friday can be today", () => {
  // 2025-01-17 is a Friday.
  expect(dates("standup moved to friday", "2025-01-17T09:00:00+05:30")).toEqual(["2025-01-17"]);
  expect(dates("standup moved to next friday", "2025-01-17T09:00:00+05:30")).toEqual(["2025-01-24"]);
});

// ---- the traps ---------------------------------------------------------

test("a month name used as an ordinary word is not a date", () => {
  // "may" is a verb far more often than a month in a transcript, and "march"
  // is a thing you do. A preposition is what makes a bare month temporal.
  expect(at("we may ship it before the review")).toEqual([]);
  expect(at("they will march on the office")).toEqual([]);
  // With a preposition, it is a date again.
  expect(dates("ship it by may")).toEqual(["2025-05-01"]);
});

test("one phrase produces one mention, not one per pattern that matches it", () => {
  // MONTH_YEAR and BARE_MONTH both fire on "in november 2026". Two reminders
  // for one sentence is worse than none.
  const got = at("renew it in november 2026");
  expect(got).toHaveLength(1);
  expect(got[0]?.precision).toBe("month");
});

test("a repeated month is one mention, and order follows the text", () => {
  const got = at("start in august, and again in august, then by december");
  expect(got.map((m) => m.at)).toEqual(["2025-08-01", "2025-12-01"]);
});

test("every mention quotes the text that produced it", () => {
  // Anything surfaced proactively has to be traceable to the note, or a bad
  // parse becomes a mysterious alarm.
  for (const m of at("passport expires november 2026 so start in august")) {
    expect(m.text.length).toBeGreaterThan(0);
    expect("passport expires november 2026 so start in august").toContain(m.text);
  }
});

test("an unparseable capture time yields nothing rather than throwing", () => {
  expect(mentionedDates("start in august", "not a date")).toEqual([]);
});

// ---- persistence and the digest ----------------------------------------

import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";
import { describe as label, recordDates, upcomingDates } from "../src/dates.ts";
import { buildDigest, renderDigest } from "../src/digest.ts";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tama-dates-"));
  db = openDb(join(dir, "tama.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date(2025, 0, 14, 9, 0);

test("a month-precision date never renders as a day", () => {
  // The whole trap: the note said "november 2026". Printing 1 November would
  // be this code asserting a day the owner never gave.
  expect(label({ text: "november 2026", at: "2026-11-01", precision: "month" })).toBe("November 2026");
  expect(label({ text: "15th of march", at: "2025-03-15", precision: "day" })).toBe("15 March 2025");
});

test("re-reading a note replaces its dates instead of accumulating them", () => {
  // The table is derived and the note is the truth, so an extractor that
  // improves must not leave yesterday's wrong guesses behind.
  recordDates(db, "Inbox/a.md", [{ text: "in august", at: "2025-08-01", precision: "month" }]);
  recordDates(db, "Inbox/a.md", [{ text: "15 august", at: "2025-08-15", precision: "day" }]);
  const rows = db.query("SELECT at FROM note_dates WHERE note_path = ?").all("Inbox/a.md");
  expect(rows).toEqual([{ at: "2025-08-15" }]);
});

test("upcoming covers the window inclusively and ignores what is outside it", () => {
  recordDates(db, "Inbox/past.md", [{ text: "yesterday", at: "2025-01-13", precision: "day" }]);
  recordDates(db, "Inbox/today.md", [{ text: "today", at: "2025-01-14", precision: "day" }]);
  recordDates(db, "Inbox/edge.md", [{ text: "21 january", at: "2025-01-21", precision: "day" }]);
  recordDates(db, "Inbox/far.md", [{ text: "november 2026", at: "2026-11-01", precision: "month" }]);

  const got = upcomingDates(db, NOW, 7);
  expect(got.map((u) => u.at)).toEqual(["2025-01-14", "2025-01-21"]);
});

test("the digest quotes the note and cites it, so a bad parse looks like one", () => {
  recordDates(db, "Inbox/2025-01-18-1105-rent.md", [
    { text: "15th of march", at: "2025-01-16", precision: "day" },
  ]);
  const rendered = renderDigest(buildDigest(db, "2025-01-13T00:00:00.000Z", NOW));
  expect(rendered.message).toContain("coming up:");
  expect(rendered.message).toContain('"15th of march"');
  expect(rendered.message).toContain("Inbox/2025-01-18-1105-rent.md");
});

test("nothing coming up adds no section rather than an empty one", () => {
  const rendered = renderDigest(buildDigest(db, "2025-01-13T00:00:00.000Z", NOW));
  expect(rendered.message).not.toContain("coming up");
});
