import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db.ts";
import { findAsk, recordAsk, recordFeedback, feedbackPath, type FeedbackEntry } from "../src/feedback.ts";

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tama-feedback-"));
  db = openDb(join(dir, "data/tama.db"));
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

const ask = (id: string, thread: string, question: string, paths: string[] = ["Work/a.md"]) =>
  recordAsk(db, { id, thread, question, sources: paths.map((p, i) => ({ path: p, score: 10 - i })) });

test("feedback attaches to the latest answer in its own thread", async () => {
  ask("1", "owner:chat", "what did I say about the mic gain");
  ask("2", "owner:chat", "and the rent");
  ask("3", "owner:group", "something else entirely");

  expect(findAsk(db, "owner:chat")?.question).toBe("and the rent");
  // Threads do not bleed: rating in one must not reach into another.
  expect(findAsk(db, "owner:group")?.question).toBe("something else entirely");
  expect(findAsk(db, "owner:nothing-here")).toBeNull();
});

test("an answer can be named outright, not only as the most recent one", async () => {
  ask("1", "owner:chat", "the older question");
  ask("2", "owner:chat", "the newer question");
  expect(findAsk(db, "owner:chat", "1")?.question).toBe("the older question");
  // And an id from another thread is not reachable by naming it.
  ask("3", "owner:other", "somebody else's");
  expect(findAsk(db, "owner:chat", "3")).toBeNull();
});

test("the retrieved paths are what the server saw, not what a client reported", async () => {
  // An audience with cite:false is never told the paths, so it could not echo
  // them back, and trusting it to would mean accepting paths it should not know.
  ask("1", "owner:chat", "who is on call", ["Work/oncall-rotation.md", "Work/q1-goals.md"]);
  expect(findAsk(db, "owner:chat")?.sources).toEqual([
    { path: "Work/oncall-rotation.md", score: 10 },
    { path: "Work/q1-goals.md", score: 9 },
  ]);
});

test("a busy thread cannot age out a quiet one's answer", async () => {
  ask("keep", "owner:quiet", "the one about to be rated");
  for (let i = 0; i < 40; i++) ask(`loud-${i}`, "owner:busy", `question ${i}`);
  // Bounded per thread, not globally.
  expect(findAsk(db, "owner:quiet")?.question).toBe("the one about to be rated");
  expect((db.query("SELECT count(*) n FROM asks WHERE thread = ?").get("owner:busy") as { n: number }).n).toBe(10);
});

test("a corrupt sources column still yields the question", async () => {
  // Losing the paths costs triage. Refusing the record would cost the case,
  // which is the only thing that cannot be recovered later.
  db.query("INSERT INTO asks (id, thread, question, sources, at) VALUES (?,?,?,?,?)")
    .run("x", "owner:chat", "a real question", "{not json", new Date().toISOString());
  const found = findAsk(db, "owner:chat");
  expect(found?.question).toBe("a real question");
  expect(found?.sources).toEqual([]);
});

test("a blank thread or question records nothing rather than a useless row", async () => {
  recordAsk(db, { id: "a", thread: "", question: "q", sources: [] });
  recordAsk(db, { id: "b", thread: "owner:chat", question: "   ", sources: [] });
  expect((db.query("SELECT count(*) n FROM asks").get() as { n: number }).n).toBe(0);
});

test("the notebook is one JSON object per line, shaped like a golden case", async () => {
  const dataDir = join(dir, "data");
  const entry: FeedbackEntry = {
    at: "2026-09-08T12:00:00.000Z",
    verdict: "wrong",
    question: "what can be the issue",
    retrieved: [{ path: "Projects/hermes/issue-3119.md", score: 8.4 }],
    note: "answered about a github issue, I meant the 500",
  };
  await recordFeedback(dataDir, entry);
  await recordFeedback(dataDir, { ...entry, verdict: "right", note: undefined });

  const lines = (await readFile(feedbackPath(dataDir), "utf8")).trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(JSON.parse(lines[0]!)).toEqual(entry);
  // `find` and `top` in golden.ts are written from the retrieved paths, so the
  // score has to survive the round trip.
  expect(JSON.parse(lines[1]!).retrieved[0].score).toBe(8.4);
  expect(JSON.parse(lines[1]!).note).toBeUndefined();
});
