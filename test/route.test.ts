import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Llm } from "../src/llm.ts";
import {
  checkDestination, firstJsonObject, integrateNote, noteBody, planCapture,
  refreshNow, stripFences, universe, waiting, wikilinks,
} from "../src/route.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tama-route-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Answers a scripted completion, so a routing decision is testable offline. */
function stub(...answers: string[]): Llm {
  let i = 0;
  return {
    name: "stub",
    async *stream() {
      yield answers[i++] ?? "";
    },
  };
}

test("json survives a model that fences it and talks first", () => {
  // Told to answer with JSON and nothing else, models still do all of this.
  expect(firstJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(firstJsonObject('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  expect(firstJsonObject('{"a":{"b":2}}')).toEqual({ a: { b: 2 } });
  // A brace inside a string must not close the object.
  expect(firstJsonObject('{"a":"} not the end"}')).toEqual({ a: "} not the end" });
  expect(firstJsonObject("no json here")).toBeNull();
  expect(firstJsonObject("{ unterminated")).toBeNull();
});

test("a capture is read without the frontmatter capture wrote", () => {
  const note = "---\nsource: voice\ncaptured: 2026-09-09T00:51:12+05:30\n---\n\nannual billing\n";
  expect(noteBody(note)).toBe("annual billing");
  expect(noteBody("no frontmatter here\n")).toBe("no frontmatter here");
});

test("links are found case-insensitively and deduped", () => {
  // These are the edges of the graph, so the comparison has to be forgiving
  // about the things Obsidian allows: aliases, headings, repeats.
  expect(wikilinks("see [[Remote Star]] and [[remote star|RS]] and [[Ideas#Top]]"))
    .toEqual(["remote star", "ideas"]);
  expect(wikilinks("none")).toEqual([]);
});

test("a fenced note is unwrapped, because a fence would swallow the note", () => {
  expect(stripFences("```markdown\n# Hi\n\nbody\n```")).toBe("# Hi\n\nbody");
  expect(stripFences("# Hi\n\nbody")).toBe("# Hi\n\nbody");
});

test("the universe is what exists outside the Inbox", async () => {
  await mkdir(join(root, "Inbox"), { recursive: true });
  await mkdir(join(root, "Projects", "remote-star"), { recursive: true });
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, "Inbox", "2026-09-09-0051-voice.md"), "x");
  await writeFile(join(root, "now.md"), "x");
  await writeFile(join(root, "Projects", "remote-star", "notes.md"), "x");
  await writeFile(join(root, "Projects", "remote-star", "cover.png"), "x");
  await writeFile(join(root, ".git", "config.md"), "x");

  const u = await universe(root, "Inbox");
  expect(u.notes).toEqual(["now.md", "Projects/remote-star/notes.md"]);
  expect(u.topLevel).toEqual(["Projects"]);
});

test("a destination is an existing note, or one new folder inside an existing root", () => {
  const u = { notes: ["Projects/remote-star/notes.md", "now.md"], topLevel: ["Projects", "People"] };
  const ok = (d: string) => checkDestination(d, u, "Inbox").ok;

  expect(ok("Projects/remote-star/notes.md")).toBe(true);
  // Starting a new project under a folder that exists is the point.
  expect(ok("Projects/tama/notes.md")).toBe(true);
  expect(ok("People/aisha.md")).toBe(true);

  // A model left free grows Misc/ beside Projects/ and the tree stops meaning
  // anything, so a new top-level folder is refused.
  expect(ok("Misc/thoughts.md")).toBe(false);
  expect(ok("Inbox/2026-09-09-0051-voice.md")).toBe(false);
  expect(ok("loose.md")).toBe(false);
  expect(ok("Projects/../../etc/passwd.md")).toBe(false);
  expect(ok("Projects/a/b/c/notes.md")).toBe(false);
  expect(ok("Projects/remote-star/notes.txt")).toBe(false);
});

test("an off-list destination leaves the capture unfiled but keeps its open loops", async () => {
  // The plan is not thrown away with the bad path: the tasks it found are
  // still worth putting in now.md, and the capture waits for a better cycle.
  const llm = stub(JSON.stringify({
    destination: "Misc/random.md",
    title: "billing",
    confidence: 0.9,
    openLoops: ["decide annual vs monthly"],
    reason: "felt right",
  }));
  const plan = await planCapture(llm, {
    capture: "annual billing, two months free",
    universe: { notes: [], topLevel: ["Projects"] },
    inbox: "Inbox",
  });
  expect(plan.destination).toBeNull();
  expect(plan.confidence).toBe(0);
  expect(plan.reason).toContain("not an existing top-level folder");
  expect(plan.openLoops).toEqual(["decide annual vs monthly"]);
});

test("a plan survives a model that answers with prose around its json", async () => {
  const llm = stub('Sure!\n```json\n{"destination":"Projects/remote-star/notes.md","title":"pricing","confidence":0.82,"openLoops":[]}\n```');
  const plan = await planCapture(llm, {
    capture: "client pushed back on monthly",
    universe: { notes: ["Projects/remote-star/notes.md"], topLevel: ["Projects"] },
    inbox: "Inbox",
  });
  expect(plan.destination).toBe("Projects/remote-star/notes.md");
  expect(plan.confidence).toBeCloseTo(0.82);
});

test("an unparseable answer is a zero-confidence plan, not a crash", async () => {
  const plan = await planCapture(stub("I'm not sure what you want."), {
    capture: "mm",
    universe: { notes: [], topLevel: ["Projects"] },
    inbox: "Inbox",
  });
  expect(plan.destination).toBeNull();
  expect(plan.confidence).toBe(0);
});

test("a rewrite that drops a link is refused", async () => {
  // The failure that matters. A model asked to be concise takes the [[links]]
  // out first, and a vault without edges is a folder of files.
  const current = "## Pricing\n\nMonthly only, see [[Remote Star]] and [[Billing]].\n";
  const bad = await integrateNote(stub("## Pricing\n\nAnnual billing now.\n"), {
    relPath: "Projects/remote-star/notes.md",
    current,
    capture: "went annual, two months free",
  });
  expect("error" in bad && bad.error).toContain("dropped links");
  expect("error" in bad && bad.error).toContain("billing");
});

test("a rewrite that keeps the links is accepted, fences and all", async () => {
  const current = "## Pricing\n\nMonthly only, see [[Remote Star]].\n";
  const good = await integrateNote(
    stub("```markdown\n## Pricing\n\nAnnual billing, two months free. See [[Remote Star]].\n```"),
    { relPath: "Projects/remote-star/notes.md", current, capture: "went annual" },
  );
  expect("text" in good && good.text).toBe("## Pricing\n\nAnnual billing, two months free. See [[Remote Star]].");
});

test("an empty rewrite is refused rather than written", async () => {
  const r = await integrateNote(stub("   "), { relPath: "a/b.md", current: "body", capture: "x" });
  expect("error" in r && r.error).toContain("returned nothing");
});

test("now.md is only rewritten when there is something to add", async () => {
  const none = await refreshNow(stub("## Now\n\n- nothing\n"), { current: "## Now\n", loops: [] });
  expect("error" in none && none.error).toContain("nothing new");

  const kept = await refreshNow(stub("## Now\n\n- decide billing for [[Remote Star]]\n"), {
    current: "## Now\n\n- chase [[Remote Star]] invoice\n",
    loops: ["decide billing"],
  });
  expect("text" in kept).toBe(true);

  const lost = await refreshNow(stub("## Now\n\n- decide billing\n"), {
    current: "## Now\n\n- chase [[Remote Star]] invoice\n",
    loops: ["decide billing"],
  });
  expect("error" in lost && lost.error).toContain("dropped links");
});

test("the Inbox listing carries an age, so a capture is not grabbed mid-commit", async () => {
  await mkdir(join(root, "Inbox"), { recursive: true });
  await writeFile(join(root, "Inbox", "2026-09-09-0051-voice.md"), "---\nsource: voice\n---\n\nhello\n");
  await writeFile(join(root, "Inbox", ".hidden.md"), "x");
  await writeFile(join(root, "Inbox", "notes.txt"), "x");

  const list = await waiting(root, "Inbox", new Date(Date.now() + 300_000));
  expect(list).toHaveLength(1);
  expect(list[0]!.relPath).toBe("Inbox/2026-09-09-0051-voice.md");
  expect(list[0]!.ageSeconds).toBeGreaterThan(290);
  expect(noteBody(list[0]!.text)).toBe("hello");
});

test("a missing Inbox is empty, not an error", async () => {
  expect(await waiting(root, "Inbox")).toEqual([]);
});
