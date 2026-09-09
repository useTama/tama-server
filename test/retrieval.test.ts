import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GrepRetriever, foldBody } from "../src/retrieval.ts";
import type { Retriever } from "../src/retrieval.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tama-retrieval-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CAPTURED = "2026-08-20T21:07:22+05:30";

type NoteFront = { captured?: string; client?: string };

/**
 * Write a note in the exact shape Vault.capture produces: frontmatter block,
 * blank line, then the transcript. The fixtures have to match that byte layout
 * or the frontmatter tests below prove nothing about real vault files.
 *
 * Pass null for the hand-written notes that predate the device and carry no
 * frontmatter at all. Most of the vault looks like that.
 */
async function note(rel: string, body: string, front: NoteFront | null = {}): Promise<string> {
  const abs = join(root, rel);
  await mkdir(dirname(abs), { recursive: true });
  const head = front
    ? [
        "---",
        "source: voice",
        `captured: ${front.captured ?? CAPTURED}`,
        `client: ${JSON.stringify(front.client ?? "cheeko-01")}`,
        "---",
        "",
      ]
    : [];
  await writeFile(abs, [...head, body, ""].join("\n"), "utf8");
  return rel;
}

// ---- finding a note ------------------------------------------------------

test("a note whose body contains the query term is found, at a vault-relative path", async () => {
  await note("Inbox/2026-08-20-2107-voice.md", "the compressor rig is finally wired up");

  const hits = await new GrepRetriever(root).search("compressor");

  expect(hits).toHaveLength(1);
  // The path is cited back to the user and later opened in Obsidian, so it is
  // relative to the vault. An absolute path leaks this machine's mkdtemp dir
  // into answers and breaks the moment the vault is opened from the other Mac.
  expect(hits[0]!.path).toBe("Inbox/2026-08-20-2107-voice.md");
  expect(hits[0]!.text).toContain("compressor rig");
});

test("a match nested several folders deep keeps its whole relative path", async () => {
  await note("Projects/anvesha/thermals.md", "the radiator loop holds pressure overnight");

  const hits = await new GrepRetriever(root).search("radiator");

  expect(hits).toHaveLength(1);
  expect(hits[0]!.path).toBe("Projects/anvesha/thermals.md");
});

test("a note sharing none of the query terms is left out", async () => {
  await note("Inbox/a.md", "the radiator loop holds pressure overnight");
  await note("Inbox/b.md", "call smitha about the workshop booking");

  const hits = await new GrepRetriever(root).search("radiator pressure");

  expect(hits.map((h) => h.path)).toEqual(["Inbox/a.md"]);
});

test("a hand-written note with no frontmatter is still searchable", async () => {
  await note("Research/whisper-notes.md", "the model stays resident between calls", null);

  const hits = await new GrepRetriever(root).search("resident");

  expect(hits.map((h) => h.path)).toEqual(["Research/whisper-notes.md"]);
  expect(hits[0]!.text).toContain("stays resident");
});

// ---- ranking and limits --------------------------------------------------

test("matching more distinct terms outranks repeating a single term", async () => {
  await note("Inbox/breadth.md", "the lidar mount arrived and the enclosure is printed");
  await note("Inbox/depth.md", "lidar lidar lidar lidar lidar lidar lidar");

  const hits = await new GrepRetriever(root).search("lidar enclosure");

  // Raw term frequency puts depth.md first. An answer built on that ranking
  // quotes the one note that hammers a single word instead of the note that
  // actually covers the question asked.
  expect(hits.map((h) => h.path)).toEqual(["Inbox/breadth.md", "Inbox/depth.md"]);
  expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
});

test("the limit argument caps how many chunks come back", async () => {
  for (const n of ["a", "b", "c", "d", "e"]) {
    await note(`Inbox/${n}.md`, "the sensor board draws too much current");
  }
  const r = new GrepRetriever(root);

  expect(await r.search("sensor", 2)).toHaveLength(2);
  expect(await r.search("sensor", 4)).toHaveLength(4);
  // A limit above the number of matches is not padded out with non-matches.
  expect(await r.search("sensor", 50)).toHaveLength(5);
});

// ---- what must never be indexed ------------------------------------------

test("a matching note planted in .git or .tama is never returned", async () => {
  await note("Inbox/real.md", "the gasket order needs chasing");
  await note(".git/COMMIT_EDITMSG.md", "the gasket order needs chasing");
  await note(".tama/journal-note.md", "the gasket order needs chasing");

  const hits = await new GrepRetriever(root).search("gasket");

  // .tama holds Tama's own write journal. Index it and the record of what the
  // server wrote comes back as source material, so the server answers from its
  // own log. .git is the same problem with old revisions of every note.
  expect(hits.map((h) => h.path)).toEqual(["Inbox/real.md"]);
});

// ---- frontmatter is bookkeeping, not content -----------------------------

test("a term that appears only in frontmatter does not make the note a match", async () => {
  await note("Inbox/a.md", "the antenna gain is lower than the datasheet claims", {
    client: "gearbox-01",
  });

  const hits = await new GrepRetriever(root).search("gearbox");

  // Every note carries a client name and a source, so matching on frontmatter
  // makes those words match the entire vault at once.
  expect(hits).toEqual([]);
});

test("the excerpt carries body prose and never the frontmatter block", async () => {
  await note("Inbox/a.md", "the antenna gain is lower than the datasheet claims", {
    client: "gearbox-01",
  });

  const hits = await new GrepRetriever(root).search("antenna");

  expect(hits[0]!.text).toContain("antenna gain");
  // Left in the excerpt, frontmatter spends context on nothing and reads as
  // something the user actually said, so "source: voice" can surface as an
  // answer to a question about sources.
  expect(hits[0]!.text).not.toContain("source: voice");
  expect(hits[0]!.text).not.toContain("captured:");
  expect(hits[0]!.text).not.toContain("gearbox-01");
  expect(hits[0]!.text).not.toContain("---");
});

test("capturedAt is read from the frontmatter, not from the file on disk", async () => {
  await note("Inbox/a.md", "the bearing arrived a day early", {
    captured: "2026-07-04T23:41:09+05:30",
  });

  const hits = await new GrepRetriever(root).search("bearing");

  expect(hits[0]!.capturedAt).toBeDefined();
  // Compared as an instant rather than as a string: normalising the offset to
  // UTC is still correct, reporting the fixture's mtime is not. Every note in
  // a freshly cloned vault has today's mtime, which would date the whole
  // vault to the clone.
  expect(Date.parse(hits[0]!.capturedAt!)).toBe(Date.parse("2026-07-04T23:41:09+05:30"));
});

// ---- edges and determinism ----------------------------------------------

test("an empty vault returns no chunks instead of throwing", async () => {
  expect(await new GrepRetriever(root).search("anything")).toEqual([]);
});

test("repeating the same search returns the same order", async () => {
  // Identical bodies, so every score ties. readdir is not required to return
  // entries in a stable order, so ties have to break on something fixed such
  // as the path. Otherwise the same question is answered from a different
  // note each time it is asked, which reads as the brain forgetting.
  for (const n of ["c", "a", "b", "d"]) {
    await note(`Inbox/${n}.md`, "the rover chassis is bolted to the frame");
  }
  const r = new GrepRetriever(root);

  const first = (await r.search("chassis")).map((h) => h.path);
  const second = (await r.search("chassis")).map((h) => h.path);
  const third = (await r.search("chassis")).map((h) => h.path);

  expect(first).toHaveLength(4);
  expect(second).toEqual(first);
  expect(third).toEqual(first);
});

test("a query full of shell metacharacters is searched for, not executed", async () => {
  await note("Inbox/a.md", "the enclosure gasket needs a redesign");

  const hits = await new GrepRetriever(root).search(
    `$(touch ${join(root, "pwned")}) \`id\` ; rm -rf / | grep gasket`,
  );

  // The query arrives from a transcript, which is untrusted the whole way down
  // (see Vault). A retriever named after grep is the obvious place for a query
  // to reach a shell or an unescaped regex, so both are checked here: nothing
  // ran, and an unbalanced paren did not blow up the search.
  expect(existsSync(join(root, "pwned"))).toBe(false);
  expect(hits.map((h) => h.path)).toEqual(["Inbox/a.md"]);
});

test("GrepRetriever satisfies the Retriever contract its callers hold", async () => {
  // Typecheck assertion as much as a runtime one: index.ts holds one of these
  // behind the interface, so a signature drift fails here instead of at the
  // call site.
  const r: Retriever = new GrepRetriever(root, { maxFileBytes: 256 * 1024, maxFiles: 500 });
  expect(await r.search("nothing at all")).toEqual([]);
});

test("a view bounds what retrieval can return at all", async () => {
  const root = await mkdtemp(join(tmpdir(), "tama-view-"));
  try {
    await mkdir(join(root, "Work"), { recursive: true });
    await mkdir(join(root, "KiksStudios/Clients"), { recursive: true });
    await writeFile(join(root, "Work/cpa.md"), "the mic gain problem in the studio");
    await writeFile(join(root, "KiksStudios/Clients/a.md"), "the mic gain problem for a client");

    const retriever = new GrepRetriever(root);
    const all = await retriever.search("mic gain problem");
    expect(all.map((c) => c.path).sort()).toEqual(["KiksStudios/Clients/a.md", "Work/cpa.md"]);

    const scoped = await retriever.search("mic gain problem", 8, { include: ["Work/**"] });
    expect(scoped.map((c) => c.path)).toEqual(["Work/cpa.md"]);

    // The point of filtering in the walk: an excluded note must not consume a
    // slot in the budget, or a narrowed audience gets worse answers silently.
    const oneSlot = await retriever.search("mic gain problem", 1, { include: ["Work/**"] });
    expect(oneSlot.map((c) => c.path)).toEqual(["Work/cpa.md"]);

    expect(await retriever.search("mic gain problem", 8, { include: [] })).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---- plural queries against singular notes -------------------------------

/**
 * The failure that prompted `variants`, from a real WhatsApp exchange.
 *
 * "whats my todos" tokenises to ["whats", "todos"], and suffix tolerance runs
 * the wrong way: needle "todos" cannot match a note that writes "TODO:". So the
 * log holding every actual todo scored zero, while a note that used the word
 * "todos" in a sentence ranked first, and the answer was a confident subset of
 * the wrong notes.
 */
test("a plural question finds a note written in the singular", async () => {
  await note("Log.md", "TODO: fix the untidy test/e2e go module on pr 3125\nTODO: reply to tariq on pr 3138", null);
  await note("Chat.md", "we were talking about todos in general", null);

  const got = await new GrepRetriever(root).search("whats my todos");
  expect(got.map((c) => c.path)).toContain("Log.md");
});

test("the singular form scores under the same term, not as a second one", async () => {
  // A note saying both "todos" and "todo" must not out-cover a note that
  // answers the whole question. Coverage is the heaviest signal there is, so
  // double-counting one term here would quietly reorder every result.
  await note("Both.md", "todos and todo", null);
  await note("Whole.md", "these are the deploy todos", null);

  const got = await new GrepRetriever(root).search("deploy todos");
  expect(got[0]?.path).toBe("Whole.md");
});

test("a word ending in ss or us is not stripped into a shorter prefix", async () => {
  // "class" -> "clas" is suffix-tolerant and would match "clash"; "status" ->
  // "statu" would match "statue". Both words were already correct.
  await note("Clash.md", "there was a clash in the schedule", null);
  await note("Class.md", "the class was moved to friday", null);

  const got = await new GrepRetriever(root).search("class");
  expect(got.map((c) => c.path)).toEqual(["Class.md"]);
});

// ---- transcribed numbers -------------------------------------------------

/**
 * Both sides of a search are Whisper output, and it is not consistent about
 * where a number ends. Each inconsistency used to cost the query its most
 * identifying term while still returning the note on the generic words, which
 * is worse than a miss: it looks like a weak answer rather than a broken match.
 */
test("a number split from its metric name scores the same as the joined form", async () => {
  await note("Work/latency.md", "the p95 latency on the list endpoint is too high", null);
  const r = new GrepRetriever(root);

  const joined = await r.search("why is p95 latency high");
  const split = await r.search("why is p 95 latency high");
  expect(split[0]?.path).toBe("Work/latency.md");
  expect(split[0]?.score).toBe(joined[0]!.score);
});

test("a thousands separator in the question does not split the number", async () => {
  await note("Car/service.md", "next service is due at 40000 km", null);
  const got = await new GrepRetriever(root).search("what about 40,000 km");
  expect(got.map((c) => c.path)).toContain("Car/service.md");
});

test("a number split in the NOTE scores the same as the joined form", async () => {
  // The mirror of the case above, and the half that was still broken: the
  // query-side fold shipped, the note-side one did not, so whichever side
  // Whisper happened to split decided whether the discriminating term counted.
  // Both sides are transcripts, so folding one of them fixes half the cases.
  await note("Work/split.md", "the p 95 latency on the list endpoint is too high", null);
  await note("Work/joined.md", "the p95 latency on the list endpoint is too high", null);
  const got = await new GrepRetriever(root).search("why is p95 latency high");

  const split = got.find((c) => c.path === "Work/split.md");
  const joined = got.find((c) => c.path === "Work/joined.md");
  expect(split).toBeDefined();
  // Equality, not "better than before". Two notes saying the same thing in the
  // two spellings Whisper produces have to be indistinguishable, and anything
  // weaker than an equality passes while the asymmetry is merely smaller.
  expect(split!.score).toBe(joined!.score);
});

test("a thousands separator in the NOTE does not cost the number", async () => {
  await note("Car/sep.md", "the tail was 40,000 ms after the fix", null);
  await note("Car/plain.md", "the tail was 40000 ms after the fix", null);
  const got = await new GrepRetriever(root).search("what about 40000 ms");
  const sep = got.find((c) => c.path === "Car/sep.md");
  const plain = got.find((c) => c.path === "Car/plain.md");
  expect(sep).toBeDefined();
  expect(sep!.score).toBe(plain!.score);
});

test("folding the note adds matches and never removes one", async () => {
  // The reason the body is searched twice rather than replaced by its folded
  // form. Folding deletes characters, so the digit-boundary rule starts
  // applying where it did not, and a note written with a separator loses the
  // term a bare-number query is looking for - the same failure as above, in
  // the other direction, costing a note that used to be found.
  await note("Ops/dump.md", "the dump landed in events_2025_01_15 and it was fine", null);
  await note("Car/km.md", "next service is due at 40,000 km", null);
  const r = new GrepRetriever(root);

  // Queried the way it is written, which folding must not break.
  const byYear = await r.search("which dump for 2025");
  expect(byYear.map((c) => c.path)).toContain("Ops/dump.md");

  const bare = await r.search("what happens at 40 thousand");
  expect(bare.map((c) => c.path)).toContain("Car/km.md");
});

test("foldBody keeps an astral numeral whole", () => {
  // Asserted on foldBody directly rather than through a search, because
  // through a search it proves nothing: the note still comes back on its other
  // words whether the fold worked or not, so the obvious test passes with the
  // bug in place. Checked that, and it did.
  //
  // The bug: \p{N} matches surrogate pairs, so deriving the deleted span from
  // a fixed offset past the match start lands inside the pair. It deletes the
  // low surrogate instead of the separator, leaves a lone surrogate in the
  // text being scanned, and skips the fold it was called to make.
  const folded = foldBody("the count was \u{1D7DD},5 units")!;
  expect(folded).not.toBeNull();
  expect(folded.text).toBe("the count was \u{1D7DD}5 units");
  expect(folded.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test("foldBody hands back original offsets, so an excerpt still opens on the term", async () => {
  // The offset map is the only part of this with a silent failure mode: a
  // wrong map moves the excerpt window rather than the score, so the note
  // ranks correctly and quotes the wrong sentence.
  const folded = foldBody("aaaa p 95 bbbb")!;
  expect(folded.text).toBe("aaaa p95 bbbb");
  // "p95" begins at 5 in the folded text and "p" begins at 5 in the original.
  expect(folded.toOriginal(5)).toBe(5);
  // Everything after the deletion is shifted by one in the folded view.
  expect(folded.toOriginal(folded.text.indexOf("bbbb"))).toBe("aaaa p 95 bbbb".indexOf("bbbb"));
  // Nothing to fold is null, which is what makes the second pass free.
  expect(foldBody("nothing here to fold at all")).toBeNull();
});

test("the folded excerpt quotes the sentence the term is actually in", async () => {
  const filler = "x".repeat(400);
  await note("Work/deep.md", `${filler}\n\nthe p 95 latency spike on the list endpoint\n\n${filler}`, null);
  const got = await new GrepRetriever(root).search("why is p95 latency high");
  expect(got[0]?.path).toBe("Work/deep.md");
  expect(got[0]?.text).toContain("p 95 latency");
});

test("a numeric term may touch a letter but never another digit", async () => {
  // 95 inside p95 is the same number. 95 inside 1995 is not, and 40 inside
  // 40000 is not, which is the whole reason words and numbers need different
  // boundary rules.
  await note("A.md", "p95 was the metric", null);
  await note("B.md", "back in 1995 we shipped it", null);
  const got = await new GrepRetriever(root).search("95");
  expect(got.map((c) => c.path)).toEqual(["A.md"]);
});

test("a single-letter English word is not glued onto a following number", async () => {
  // "a 5 minute walk" must not normalise to "a5 minute walk", which would lose
  // the 5 and invent a term that matches nothing.
  await note("Walk.md", "it is a 5 minute walk from the station", null);
  const got = await new GrepRetriever(root).search("how long is the 5 minute walk");
  expect(got.map((c) => c.path)).toContain("Walk.md");
});
