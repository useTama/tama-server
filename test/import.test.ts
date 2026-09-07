import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSeparateImportRoots, collectMarkdown, runImport } from "../src/import.ts";

let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "tama-import-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("the source walk follows its root but skips dotdirs, binaries, and nested symlinks", async () => {
  const source = join(root, "source");
  const linkedSource = join(root, "source-link");
  const outside = join(root, "outside");
  await mkdir(join(source, "Projects"), { recursive: true });
  await mkdir(join(source, ".private"));
  await mkdir(outside);
  await writeFile(join(source, "root.md"), "root");
  await writeFile(join(source, "Projects", "project.MD"), "project");
  await writeFile(join(source, "image.png"), "not a note");
  await writeFile(join(source, ".private", "secret.md"), "hidden");
  await writeFile(join(outside, "outside.md"), "outside");
  await symlink(outside, join(source, "linked"));
  await symlink(source, linkedSource);

  const notes = await collectMarkdown(linkedSource);
  expect(notes.map((note) => note.rel)).toEqual(["Projects/project.MD", "root.md"]);
});

test("source and destination must remain separate through symlink aliases", async () => {
  const source = join(root, "source");
  const sourceAlias = join(root, "source-link");
  await mkdir(source);
  await symlink(source, sourceAlias);

  await expect(assertSeparateImportRoots(source, join(sourceAlias, "new-vault")))
    .rejects.toThrow("separate folders");
  await expect(assertSeparateImportRoots(sourceAlias, join(root, "other-vault")))
    .resolves.toBeUndefined();
});

test("the import command copies Markdown into the configured vault and is idempotent", async () => {
  const source = join(root, "source");
  const vault = join(root, "vault");
  const data = join(root, "data");
  const config = join(root, "tama.config.json");
  await mkdir(join(source, "Research"), { recursive: true });
  await mkdir(join(vault, ".git"), { recursive: true });
  await writeFile(join(source, "Research", "idea.md"), "# Idea\n\nPrivate source text.\n");
  await writeFile(config, JSON.stringify({
    vault: { path: vault, inbox: "Inbox" },
    server: { adminToken: "test-admin" },
    dataDir: data,
  }));

  const argv = ["bun", "src/tama.ts", "import", source, "--config", config];
  await runImport(argv);
  await runImport(argv);
  expect(await readFile(join(vault, "Research", "idea.md"), "utf8"))
    .toBe("# Idea\n\nPrivate source text.\n");
});
