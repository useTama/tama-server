import { test, expect } from "bun:test";
import {
  loadPinnedNotes, renderPinnedNotes, PIN_MAX_BYTES, PIN_MAX_NOTES, PIN_MAX_TOTAL_BYTES,
  type PinReader, type PinnedNote,
} from "../src/pin.ts";

/** A vault that is a map, so these tests need no disk and no Vault. */
function reader(notes: Record<string, string>): PinReader {
  return {
    async readNote(relPath: string, maxBytes = Infinity) {
      const text = notes[relPath];
      if (text === undefined) return null;
      const full = Buffer.byteLength(text, "utf8");
      const kept = full > maxBytes ? text.slice(0, maxBytes) : text;
      return { text: kept, bytes: Buffer.byteLength(kept, "utf8"), truncated: full > maxBytes };
    },
  };
}

const notices = () => {
  const said: string[] = [];
  return { said, notice: (m: string) => said.push(m) };
};

test("nothing pinned when nothing is configured", async () => {
  expect(await loadPinnedNotes(reader({}), undefined)).toEqual([]);
  expect(await loadPinnedNotes(reader({ "a.md": "x" }), {})).toEqual([]);
});

test("conventions come before state, whatever order the config lists them", async () => {
  // Structure, then what is happening inside it. A guide read after the notes
  // it governs is a footnote.
  const pins = await loadPinnedNotes(
    reader({ "CLAUDE.md": "how this vault works", "Now.md": "what is live" }),
    { state: ["Now.md"], conventions: ["CLAUDE.md"] },
  );
  expect(pins.map((p) => p.role)).toEqual(["conventions", "state"]);
  expect(pins.map((p) => p.path)).toEqual(["CLAUDE.md", "Now.md"]);
});

test("a note that is not in the vault yet is skipped and said out loud", async () => {
  const { said, notice } = notices();
  const pins = await loadPinnedNotes(reader({}), { conventions: ["CLAUDE.md"] }, undefined, notice);

  expect(pins).toEqual([]);
  expect(said).toEqual(["pin CLAUDE.md is not in the vault yet"]);
});

test("an empty note is skipped rather than pinned as nothing", async () => {
  const { said, notice } = notices();
  const pins = await loadPinnedNotes(
    reader({ "Now.md": "   \n\n" }), { state: ["Now.md"] }, undefined, notice,
  );

  expect(pins).toEqual([]);
  expect(said).toEqual(["pin Now.md is empty"]);
});

// A filename alone can disclose what a note is about, which is why NO_CITE_RULES
// exists. A conventions file listing every folder would hand a scoped group the
// shape of a vault it was given one slice of.
test("a pin its view would hide is never read", async () => {
  const { said, notice } = notices();
  let reads = 0;
  const counting: PinReader = {
    async readNote(relPath) {
      reads++;
      return { text: "secret structure", bytes: 16, truncated: false };
    },
  };

  const pins = await loadPinnedNotes(
    counting, { conventions: ["CLAUDE.md"] }, { include: ["Public/**"] }, notice,
  );

  expect(pins).toEqual([]);
  expect(reads).toBe(0);
  expect(said).toEqual(["pin CLAUDE.md skipped: this audience's view does not include it"]);
});

test("a pin the view admits is read", async () => {
  const pins = await loadPinnedNotes(
    reader({ "Public/guide.md": "the shape of things" }),
    { conventions: ["Public/guide.md"] },
    { include: ["Public/**"] },
  );
  expect(pins.map((p) => p.path)).toEqual(["Public/guide.md"]);
});

test("an unsafe path is reported, not thrown, so the question still gets answered", async () => {
  const { said, notice } = notices();
  const throwing: PinReader = {
    async readNote() { throw new Error("unsafe path: ../escape.md"); },
  };

  const pins = await loadPinnedNotes(throwing, { conventions: ["../escape.md"] }, undefined, notice);

  expect(pins).toEqual([]);
  expect(said[0]).toContain("could not be read: unsafe path");
});

test("one note listed in both roles is pinned once", async () => {
  const { said, notice } = notices();
  const pins = await loadPinnedNotes(
    reader({ "Now.md": "live" }),
    { conventions: ["Now.md"], state: ["Now.md"] },
    undefined,
    notice,
  );

  expect(pins).toHaveLength(1);
  expect(pins[0]!.role).toBe("conventions");
  expect(said[0]).toContain("listed more than once");
});

test("the pin count has a ceiling", async () => {
  const paths = Array.from({ length: PIN_MAX_NOTES + 2 }, (_, i) => `n${i}.md`);
  const notes = Object.fromEntries(paths.map((p) => [p, "content"]));
  const { said, notice } = notices();

  const pins = await loadPinnedNotes(reader(notes), { conventions: paths }, undefined, notice);

  expect(pins).toHaveLength(PIN_MAX_NOTES);
  expect(said.filter((s) => s.includes("ceiling"))).toHaveLength(2);
});

// The per-note cap bites first, so no single note can exhaust the total. Two
// notes at the per-note cap is exactly the budget, which is what makes the
// third one the first thing the running total refuses.
test("the total byte budget is spent in order, and the overflow says so", async () => {
  const atCap = "x".repeat(PIN_MAX_BYTES);
  const { said, notice } = notices();

  const pins = await loadPinnedNotes(
    reader({ "first.md": atCap, "second.md": atCap, "third.md": "never reached" }),
    { conventions: ["first.md", "second.md", "third.md"] },
    undefined,
    notice,
  );

  expect(pins.map((p) => p.path)).toEqual(["first.md", "second.md"]);
  expect(said.some((s) => s.includes("third.md") && s.includes("budget"))).toBe(true);
});

// A pin silently halved reads to the owner as a model that ignored half their
// instructions, so the cut is both reported and marked in the fence.
test("truncation is announced and carried into the rendering", async () => {
  const { said, notice } = notices();
  const pins = await loadPinnedNotes(
    reader({ "Now.md": "y".repeat(PIN_MAX_TOTAL_BYTES + 10) }),
    { state: ["Now.md"] },
    undefined,
    notice,
  );

  expect(pins[0]!.truncated).toBe(true);
  expect(said.some((s) => s.includes("was cut to fit"))).toBe(true);
  expect(renderPinnedNotes(pins)).toContain("(Now.md, truncated)");
});

test("a pin is fenced, and fenced differently from an excerpt", async () => {
  const pins: PinnedNote[] = [
    { role: "conventions", path: "CLAUDE.md", text: "Now.md is the source of truth", truncated: false },
    { role: "state", path: "Now.md", text: "shipping the pin", truncated: false },
  ];
  const rendered = renderPinnedNotes(pins);

  expect(rendered).toContain("--- BEGIN VAULT GUIDE (CLAUDE.md) ---");
  expect(rendered).toContain("--- END VAULT GUIDE ---");
  expect(rendered).toContain("--- BEGIN CURRENT STATE (Now.md) ---");
  expect(rendered).toContain("--- END CURRENT STATE ---");
  // The distinction is load-bearing: a model that cannot tell a pin from a
  // matched excerpt cannot apply "the guide outranks recency".
  expect(rendered).not.toContain("BEGIN NOTE");
});

// This threw, and a throw here fails the whole question. `seen` recorded the
// path before the missing/hidden/empty checks, then the notice read the role
// back out of `out`, where a skipped pin never landed.
test("a duplicate whose first mention was skipped does not throw", async () => {
  const { said, notice } = notices();
  const pins = await loadPinnedNotes(
    reader({}), { conventions: ["Now.md"], state: ["Now.md"] }, undefined, notice,
  );

  expect(pins).toEqual([]);
  expect(said).toContain("pin Now.md is not in the vault yet");
  expect(said).toContain("pin Now.md is listed more than once, so only the conventions entry is used");
});

test("a duplicate hidden by the view does not throw either", async () => {
  const pins = await loadPinnedNotes(
    reader({ "Secret.md": "x" }),
    { conventions: ["Secret.md"], state: ["Secret.md"] },
    { include: ["Public/**"] },
  );
  expect(pins).toEqual([]);
});

// `remaining` is a byte count and was applied as a character count, so a
// Devanagari or CJK pin kept up to three times the bytes it was allowed.
test("the byte budget is counted in bytes, not characters", async () => {
  const ascii = "x".repeat(PIN_MAX_BYTES);
  // Three bytes per character in UTF-8.
  const devanagari = "क".repeat(PIN_MAX_BYTES);

  const pins = await loadPinnedNotes(
    reader({ "first.md": ascii, "second.md": devanagari }),
    { conventions: ["first.md", "second.md"] },
  );

  const total = pins.reduce((n, p) => n + Buffer.byteLength(p.text, "utf8"), 0);
  expect(total).toBeLessThanOrEqual(PIN_MAX_TOTAL_BYTES);
});

test("cutting a multi-byte pin does not leave half a character", async () => {
  const pins = await loadPinnedNotes(
    reader({ "a.md": "x".repeat(PIN_MAX_TOTAL_BYTES - 1), "b.md": "क".repeat(100) }),
    { conventions: ["a.md", "b.md"] },
  );
  const last = pins.at(-1)!;
  expect(last.text).not.toContain("�");
});
