import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { GrepRetriever } from "../src/retrieval.ts";
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
