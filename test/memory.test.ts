import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { asMessages, forget, isSmallTalk, recall, remember, searchQuery, summarise, KEEP_TURNS, SUMMARISE_AFTER, type Turn } from "../src/memory.ts";
import type { Llm } from "../src/llm.ts";

async function db() {
  const dir = await mkdtemp(join(tmpdir(), "tama-memory-"));
  return { db: openDb(join(dir, "t.db")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const fakeLlm = (reply: string): Llm => ({
  name: "fake",
  async *stream() {
    yield reply;
  },
});

test("a thread remembers what was said, oldest first", async () => {
  const { db: d, cleanup } = await db();
  try {
    remember(d, "chat", "user", "kya chaiye", "Shivansh");
    remember(d, "chat", "assistant", "cheese popcorn");
    remember(d, "chat", "user", "kitne");
    const { turns, summary } = recall(d, "chat");
    expect(turns.map((t) => t.text)).toEqual(["kya chaiye", "cheese popcorn", "kitne"]);
    expect(turns[0]!.speaker).toBe("Shivansh");
    expect(summary).toBeUndefined();
  } finally {
    d.close();
    await cleanup();
  }
});

test("threads do not leak into each other", async () => {
  const { db: d, cleanup } = await db();
  try {
    remember(d, "a", "user", "secret");
    remember(d, "b", "user", "other");
    expect(recall(d, "a").turns.map((t) => t.text)).toEqual(["secret"]);
    expect(recall(d, "b").turns.map((t) => t.text)).toEqual(["other"]);
  } finally {
    d.close();
    await cleanup();
  }
});

test("only the tail is recalled, however long the thread", async () => {
  const { db: d, cleanup } = await db();
  try {
    for (let i = 0; i < 40; i++) remember(d, "chat", i % 2 ? "assistant" : "user", `turn ${i}`);
    const { turns } = recall(d, "chat");
    expect(turns).toHaveLength(KEEP_TURNS);
    // The tail, not the head: what was said most recently is what "it" means.
    expect(turns[turns.length - 1]!.text).toBe("turn 39");
  } finally {
    d.close();
    await cleanup();
  }
});

test("a follow-up searches on what came before it", async () => {
  // "and the other one?" contains no word from any note, so retrieving on the
  // question alone finds nothing. This is #23's cheap half.
  const turns = [
    { id: 1, role: "user" as const, text: "what did i decide about the mic gain" },
    { id: 2, role: "assistant" as const, text: "you landed on 60" },
  ];
  const query = searchQuery("and the other one?", turns);
  expect(query).toContain("mic gain");
  expect(query).toContain("and the other one?");
  // Not the assistant's words: they came from the notes, and feeding them back
  // would score those same notes higher for no reason to do with the question.
  expect(query).not.toContain("you landed on 60");
});

test("summarising folds the old turns and deletes them, atomically", async () => {
  const { db: d, cleanup } = await db();
  try {
    for (let i = 0; i < SUMMARISE_AFTER + 5; i++) {
      remember(d, "chat", i % 2 ? "assistant" : "user", `turn ${i}`);
    }
    expect(await summarise(d, "chat", fakeLlm("they argued about popcorn and settled on cheese"))).toBe(true);

    const { summary, turns } = recall(d, "chat");
    expect(summary).toBe("they argued about popcorn and settled on cheese");
    expect(turns).toHaveLength(KEEP_TURNS);
    // The recent turns survive verbatim; only the folded ones are gone.
    expect(turns[turns.length - 1]!.text).toBe(`turn ${SUMMARISE_AFTER + 4}`);
  } finally {
    d.close();
    await cleanup();
  }
});

test("a short thread is left alone", async () => {
  const { db: d, cleanup } = await db();
  try {
    remember(d, "chat", "user", "hi");
    expect(await summarise(d, "chat", fakeLlm("should not be called"))).toBe(false);
    expect(recall(d, "chat").summary).toBeUndefined();
  } finally {
    d.close();
    await cleanup();
  }
});

test("a failing summariser costs depth, not the conversation", async () => {
  const { db: d, cleanup } = await db();
  try {
    for (let i = 0; i < SUMMARISE_AFTER + 5; i++) remember(d, "chat", "user", `turn ${i}`);
    const broken: Llm = { name: "broken", async *stream() { throw new Error("402"); } };
    expect(await summarise(d, "chat", broken)).toBe(false);
    // Nothing deleted, so it can be retried on the next reply.
    expect(recall(d, "chat", 999).turns.length).toBe(SUMMARISE_AFTER + 5);
  } finally {
    d.close();
    await cleanup();
  }
});

test("a speaker is named in the message a model sees, in a room with several", async () => {
  expect(asMessages([{ id: 1, role: "user", speaker: "Suryansh", text: "abe soja" }])).toEqual([
    { role: "user", content: "Suryansh: abe soja" },
  ]);
  // One-to-one has nobody to distinguish, so no prefix.
  expect(asMessages([{ id: 1, role: "user", text: "what did i decide" }])).toEqual([
    { role: "user", content: "what did i decide" },
  ]);
});

test("forget clears both halves", async () => {
  const { db: d, cleanup } = await db();
  try {
    for (let i = 0; i < SUMMARISE_AFTER + 5; i++) remember(d, "chat", "user", `turn ${i}`);
    await summarise(d, "chat", fakeLlm("a summary"));
    forget(d, "chat");
    expect(recall(d, "chat")).toEqual({ turns: [] });
  } finally {
    d.close();
    await cleanup();
  }
});

// ---- #57: carrying context, but only when it is needed ------------------

test("a change of subject is not searched with the previous subject's words", () => {
  // The bug: carrying was unconditional, so this searched "mic gain rent
  // review". Coverage is the heaviest signal in the ranking, so the mic note
  // could cover two of three terms and beat the rent note that covered one,
  // and nothing looked wrong: a note was retrieved and an answer was cited.
  const turns = [
    { id: 1, role: "user" as const, text: "what did i decide about the mic gain" },
    { id: 2, role: "assistant" as const, text: "you landed on 60" },
  ];
  const query = searchQuery("when is the rent review", turns);
  expect(query).toBe("when is the rent review");
  expect(query).not.toContain("mic gain");
});

test("a question pointing at something already said still carries it", () => {
  // "other" and "one" survive tokenise, so counting terms cannot tell this
  // from a question that names its own subject. They are anaphora, not
  // stopwords, and that distinction is what decides this case.
  const turns = [
    { id: 1, role: "user" as const, text: "what did i decide about the mic gain" },
    { id: 2, role: "assistant" as const, text: "you landed on 60" },
  ];
  for (const follow of ["and the other one?", "other then that", "what about that"]) {
    expect(searchQuery(follow, turns)).toContain("mic gain");
  }
});

test("one substantive term is not enough to stand alone", () => {
  // "roast him too" has only "roast" and still needs to know who him is.
  const turns = [
    { id: 1, role: "user" as const, text: "what do i have on anand" },
    { id: 2, role: "assistant" as const, text: "interview feedback" },
  ];
  expect(searchQuery("roast him too", turns)).toContain("anand");
});

test("with no prior turns a question is searched as itself, whatever its shape", () => {
  expect(searchQuery("and the other one?", [])).toBe("and the other one?");
});

// ---------------------------------------------------------------- small talk

// The other half of #57. That fix stopped a question with its own subject
// being polluted by the previous one. A greeting has zero substantive terms
// too, so it fell into the same carry-forward branch: retrieve whatever they
// were last talking about, and read it out.
test("a greeting is not a search, so nothing is carried into one", () => {
  const turns: Turn[] = [
    { id: 1, role: "user", text: "what did i decide about the mic gain" },
    { id: 2, role: "assistant", text: "you landed on 60" },
  ];

  for (const hello of ["hi", "Hi?", "hello", "hey", "yo", "sup", "bruh", "ok", "haan", "gm"]) {
    expect(searchQuery(hello, turns)).toBeNull();
  }
});

test("being addressed by name is the same act as saying hello", () => {
  // Without the name, "tama" is a substantive term that matches its own
  // project notes, which is how the bare name came back with an open issue.
  expect(searchQuery("tama", [], { selfName: "Tama" })).toBeNull();
  expect(searchQuery("Tama!", [], { selfName: "tama" })).toBeNull();
  // Not its name, so still a question.
  expect(searchQuery("tama", [])).not.toBeNull();
});

test("a greeting with a question attached is still a question", () => {
  const turns: Turn[] = [{ id: 1, role: "user", text: "the mic gain thing" }];
  expect(searchQuery("hi what about the mic", turns)).not.toBeNull();
  expect(searchQuery("ok and the rent review", turns)).not.toBeNull();
});

test("a follow-up that points at the last subject still carries it", () => {
  // The #57 behaviour, unchanged. Only the no-subject-at-all case moved.
  const turns: Turn[] = [
    { id: 1, role: "user", text: "what did i decide about the mic gain" },
    { id: 2, role: "assistant", text: "you landed on 60" },
  ];
  expect(searchQuery("and the other one?", turns)).toContain("mic gain");
});

test("an empty message is not small talk, so it takes the ordinary path", () => {
  expect(isSmallTalk("")).toBe(false);
  expect(isSmallTalk("   ")).toBe(false);
});

// A bare affirmation is contact out of nowhere and a REPLY when it answers
// something we just asked. Tama asks follow-ups, so treating the answer as a
// greeting drops the thread it opened.
test("an affirmation answering our own question is not small talk", () => {
  const asked: Turn[] = [
    { id: 1, role: "user", text: "remind me about the print list" },
    { id: 2, role: "assistant", text: "kisko reminder dalna hai aur kab?" },
  ];
  for (const reply of ["haan", "yes", "sure", "done"]) {
    expect(searchQuery(reply, asked)).not.toBeNull();
  }
});

test("the same affirmation out of nowhere still is small talk", () => {
  const chatting: Turn[] = [
    { id: 1, role: "user", text: "what did i decide about the mic gain" },
    { id: 2, role: "assistant", text: "you landed on 60" },
  ];
  expect(searchQuery("haan", chatting)).toBeNull();
  expect(searchQuery("yes", [])).toBeNull();
});
