import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";
import {
  admit, dropped, limitFor, noticeFor,
  ASK_PER_WINDOW, CAPTURE_PER_WINDOW, WINDOW_MS,
} from "../src/rate-limit.ts";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tama-rate-"));
  db = openDb(join(dir, "tama.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const T0 = new Date("2026-09-08T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

test("a sender is answered up to the limit, told once, then met with silence", async () => {
  const got: string[] = [];
  for (let i = 0; i < ASK_PER_WINDOW + 4; i++) {
    got.push(admit(db, "whatsapp:text", "sender-a", ASK_PER_WINDOW, at(i * 10)));
  }
  // The one notice is the point: a bot that says "slow down" to every message
  // past the ceiling is doing the sender's work with the owner's number.
  expect(got.slice(0, ASK_PER_WINDOW)).toEqual(Array(ASK_PER_WINDOW).fill("allow"));
  expect(got[ASK_PER_WINDOW]).toBe("notify");
  expect(got.slice(ASK_PER_WINDOW + 1)).toEqual(["drop", "drop", "drop"]);
});

test("the window resets, and so does the right to be told again", async () => {
  for (let i = 0; i < ASK_PER_WINDOW; i++) admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(0));
  expect(admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(0))).toBe("notify");
  expect(admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(1))).toBe("drop");

  // Just inside the window is still the same window.
  expect(admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(WINDOW_MS - 1))).toBe("drop");
  expect(admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(WINDOW_MS))).toBe("allow");
});

test("one sender flooding does not spend another sender's budget", async () => {
  // The failure this prevents: a shared bucket means the sixth person in a
  // room is rate-limited by the first five.
  for (let i = 0; i < ASK_PER_WINDOW + 2; i++) admit(db, "whatsapp:text", "loud", ASK_PER_WINDOW, at(0));
  expect(admit(db, "whatsapp:text", "quiet", ASK_PER_WINDOW, at(0))).toBe("allow");
});

test("capture and ask are counted separately, because they fail differently", async () => {
  // Capture costs CPU and writes a file; ask costs money. Exhausting one must
  // not close the other, and dictating a run of thoughts is the product
  // working rather than abuse.
  for (let i = 0; i < ASK_PER_WINDOW + 2; i++) admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(0));
  expect(admit(db, "whatsapp:audio", "a", CAPTURE_PER_WINDOW, at(0))).toBe("allow");
  expect(limitFor("audio")).toBeGreaterThan(limitFor("text"));
});

test("drops are counted, so an ignored sender is not indistinguishable from a bug", async () => {
  for (let i = 0; i < ASK_PER_WINDOW + 3; i++) admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(0));
  // Three past the ceiling: one notified, two silent, all three counted.
  expect(dropped(db, "whatsapp:text")).toBe(3);
  expect(dropped(db)).toBe(3);
});

test("a corrupt counter row lets a message through rather than refusing it", async () => {
  db.query(
    "INSERT INTO rate_limits (scope, subject, window_at, used, notified, dropped) VALUES (?, ?, ?, ?, 0, 0)",
  ).run("whatsapp:text", "a", "not a date", 99);
  expect(admit(db, "whatsapp:text", "a", ASK_PER_WINDOW, at(0))).toBe("allow");
});

test("the notice names the surface, so a dropped voice note is not mistaken for a saved one", () => {
  expect(noticeFor("audio")).toContain("not saved");
  expect(noticeFor("text")).not.toContain("not saved");
});
