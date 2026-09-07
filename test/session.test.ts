import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.ts";
import { appendSession, projectSlug, renderEntry, sessionPath } from "../src/session.ts";

async function vault() {
  const dir = await mkdtemp(join(tmpdir(), "tama-session-"));
  await Vault.initialize(dir);
  return { vault: new Vault(dir, "Inbox", false, false), dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("a project name becomes one stable folder however it is typed", () => {
  // An agent and a person will type both, and neither expects two folders.
  expect(projectSlug("tama-server")).toBe("tama-server");
  expect(projectSlug("Tama Server")).toBe("tama-server");
  expect(projectSlug("  Kiks Studios!  ")).toBe("kiks-studios");
  expect(() => projectSlug("!!!")).toThrow(/no usable characters/);
  expect(sessionPath("Tama Server")).toBe("Projects/tama-server/sessions.md");
});

test("the first entry carries frontmatter and later ones do not", () => {
  const entry = { project: "tama", summary: "fixed mention detection", at: new Date("2026-09-07T23:15:00") };
  const first = renderEntry(entry, { withFrontmatter: true });
  expect(first).toContain("project: tama");
  expect(first).toContain("kind: sessions");
  // Retrieval needs to tell a session log from a note that mentions the
  // project, which is what the frontmatter is for.
  expect(renderEntry(entry, { withFrontmatter: false })).not.toContain("project: tama");
});

test("lists appear only when they have something in them", () => {
  const rendered = renderEntry(
    { project: "tama", summary: "a day", shipped: ["PR #37", " "], learned: [], next: ["scoped tokens"] },
    { withFrontmatter: false },
  );
  expect(rendered).toContain("**Shipped**");
  expect(rendered).toContain("- PR #37");
  expect(rendered).toContain("- scoped tokens");
  // An empty heading invites filling in, and a blank bullet is noise.
  expect(rendered).not.toContain("**Learned**");
  expect(rendered.split("- ").length).toBe(3);
});

test("sessions accumulate in one file, newest last", async () => {
  const { vault: v, dir, cleanup } = await vault();
  try {
    const first = await appendSession(v, { project: "tama", summary: "morning", at: new Date("2026-09-07T09:00:00") });
    expect(first.created).toBe(true);
    const second = await appendSession(v, { project: "Tama", summary: "evening", at: new Date("2026-09-07T21:00:00") });
    expect(second.created).toBe(false);
    // Same file, whichever way the project was typed.
    expect(second.relPath).toBe(first.relPath);

    const text = await readFile(join(dir, first.relPath), "utf8");
    expect(text.indexOf("morning")).toBeLessThan(text.indexOf("evening"));
    // One set of frontmatter, at the top, not one per entry.
    expect(text.match(/kind: sessions/g)).toHaveLength(1);
  } finally {
    await cleanup();
  }
});

test("an empty session is refused rather than written", async () => {
  const { vault: v, cleanup } = await vault();
  try {
    await expect(appendSession(v, { project: "tama", summary: "   " })).rejects.toThrow(/nothing to record/);
  } finally {
    await cleanup();
  }
});

test("an append cannot be aimed outside the vault", async () => {
  const { vault: v, cleanup } = await vault();
  try {
    for (const bad of ["../escape.md", "/etc/passwd.md", "notes/../../out.md", ".hidden/x.md", "no-extension"]) {
      await expect(v.appendMarkdown(bad, "x")).rejects.toThrow(/unsafe|escapes/);
    }
  } finally {
    await cleanup();
  }
});

test("appending twice does not lose the first write", async () => {
  const { vault: v, dir, cleanup } = await vault();
  try {
    // O_APPEND rather than read-modify-write: two agents finishing at once, or
    // one retrying, must not overwrite each other.
    await Promise.all([
      v.appendMarkdown("Projects/x/log.md", "one"),
      v.appendMarkdown("Projects/x/log.md", "two"),
    ]);
    const text = await readFile(join(dir, "Projects/x/log.md"), "utf8");
    expect(text).toContain("one");
    expect(text).toContain("two");
  } finally {
    await cleanup();
  }
});
