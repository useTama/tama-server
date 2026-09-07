import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { configPathFromArgs, loadConfig } from "./config.ts";
import { Vault } from "./vault.ts";
import { bold, grey, ok, warn } from "./ui.ts";

export type SourceNote = { abs: string; rel: string };
export type ImportSummary = { found: number; imported: number; unchanged: number; bytes: number };

function rootsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(b + sep) || b.startsWith(a + sep);
}

/** Resolve symlinked ancestors even when the final destination does not exist yet. */
async function canonicalPathAllowMissing(input: string): Promise<string> {
  let cursor = resolve(input);
  const missing: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/** Reject importing a folder into itself, including through symlink aliases. */
export async function assertSeparateImportRoots(sourceInput: string, vaultInput: string): Promise<void> {
  const sourceRoot = await realpath(resolve(sourceInput));
  const vaultRoot = await canonicalPathAllowMissing(vaultInput);
  if (rootsOverlap(sourceRoot, vaultRoot)) {
    throw new Error("import source and destination vault must be separate folders");
  }
}

/** Walk an external notes folder without following nested symlinks or dotdirs. */
export async function collectMarkdown(sourceRoot: string): Promise<SourceNote[]> {
  const root = await realpath(resolve(sourceRoot));
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`import source is not a directory: ${sourceRoot}`);

  const notes: SourceNote[] = [];
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    const entries = await readdir(absDir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const abs = `${absDir}${sep}${entry.name}`;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) notes.push({ abs, rel });
    }
  };
  await walk(root, "");
  return notes;
}

function sourceFromArgs(argv: string[]): string {
  const args = argv.slice(3);
  const configAt = args.indexOf("--config");
  if (configAt !== -1) args.splice(configAt, 2);
  const source = args.find((arg) => !arg.startsWith("--"));
  if (!source) throw new Error("a source folder is required\n  tama-server import /path/to/notes [--config PATH]");
  return resolve(source);
}

/** Shared by the standalone command and the setup wizard. Makes no network requests. */
export async function importMarkdownFolder(
  sourceInput: string,
  vaultRoot: string,
  vault: Vault,
): Promise<ImportSummary> {
  await assertSeparateImportRoots(sourceInput, vaultRoot);
  const notes = await collectMarkdown(sourceInput);
  if (notes.length === 0) throw new Error(`no Markdown notes found in ${sourceInput}`);
  await vault.preflight();

  let imported = 0;
  let unchanged = 0;
  let bytes = 0;
  for (const note of notes) {
    const raw = await readFile(note.abs);
    let noteText: string;
    try {
      noteText = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(`note is not valid UTF-8 Markdown: ${note.rel}`);
    }
    const result = await vault.importMarkdown(note.rel, noteText);
    bytes += result.bytes;
    if (result.imported) imported++;
    else unchanged++;
  }
  return { found: notes.length, imported, unchanged, bytes };
}

export async function runImport(argv: string[] = Bun.argv): Promise<void> {
  const sourceInput = sourceFromArgs(argv);
  const config = loadConfig(configPathFromArgs(argv));
  const vault = new Vault(
    config.vault.path,
    config.vault.inbox,
    config.safety.dryRun,
    config.safety.allowUnbackedVault,
  );
  const summary = await importMarkdownFolder(sourceInput, config.vault.path, vault);

  if (config.safety.dryRun) {
    console.log(warn(`Dry run: ${summary.found} Markdown notes (${summary.bytes} bytes) would be considered; nothing was written.`));
  } else {
    console.log(ok(`${summary.imported} Markdown note${summary.imported === 1 ? "" : "s"} imported, ${summary.unchanged} unchanged.`));
  }
  console.log(grey(`Source was read only and remains at ${sourceInput}.`));
  console.log(`${bold("Vault:")} ${config.vault.path}`);
}
