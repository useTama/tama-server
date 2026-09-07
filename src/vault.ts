import { mkdir, writeFile, rename, open, appendFile, stat, lstat, realpath, unlink, readdir, readFile, link } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { amber } from "./ui.ts";
export type CaptureInput = {
  /** Raw transcript. Untrusted. Never becomes a path, never touches a shell. */
  text: string;
  /** Which device caused this write. Goes in the journal. */
  source: string;
  /** When the user actually spoke. See capture-time.ts. */
  at: Date;
};

export type WriteResult = { path: string; relPath: string; bytes: number; dryRun: boolean };
export type ImportResult = WriteResult & { imported: boolean };

/**
 * Local folder adapter. A plain directory on local disk, git-tracked.
 *
 * Deliberately NOT a cloud-sync folder. iCloud, Dropbox and OneDrive serve
 * placeholder stubs for files that have not materialised, race the writer,
 * and produce conflict copies. git is the sync and backup story instead.
 *
 * This is the ONLY module allowed to touch the vault. Every invariant lives here
 * so it is enforced in one place rather than scattered across callers.
 */
export class Vault {
  constructor(
    private root: string,
    private inbox: string,
    private dryRun = false,
    private allowUnbacked = false,
  ) {}

  /**
   * Create a new, empty vault and put it under git before the server can use
   * it. Setup is intentionally conservative: it never turns an existing,
   * non-empty folder into a repository without the owner doing that directly.
   */
  static async initialize(root: string): Promise<void> {
    const abs = resolve(root);
    if (existsSync(abs)) {
      const s = await stat(abs);
      if (!s.isDirectory()) throw new Error(`vault path is not a directory: ${abs}`);
      if ((await readdir(abs)).length > 0) throw new Error(`vault already exists and is not empty: ${abs}`);
    } else {
      await mkdir(abs, { recursive: true });
    }
    const child = Bun.spawn(["git", "init", abs], { stdout: "pipe", stderr: "pipe" });
    if ((await child.exited) !== 0) {
      const detail = await new Response(child.stderr).text();
      throw new Error(`could not initialize git vault: ${detail.trim()}`);
    }
  }

  /** Invariant 3: refuse to run against an unprotected vault. */
  async preflight(): Promise<void> {
    if (!existsSync(this.root)) throw new Error(`vault does not exist: ${this.root}`);
    const s = await stat(this.root);
    if (!s.isDirectory()) throw new Error(`vault is not a directory: ${this.root}`);

    const backed = existsSync(join(this.root, ".git"));
    if (!backed && !this.allowUnbacked) {
      throw new Error(
        `vault at ${this.root} is not git-tracked and no backup is configured.\n` +
          `  fix it:      git -C "${this.root}" init\n` +
          `  or override: set safety.allowUnbackedVault = true (you accept the risk)`,
      );
    }

    // prove we can actually write before accepting any traffic
    if (!this.dryRun) {
      const probe = join(this.root, `.tama-probe-${process.pid}`);
      await writeFile(probe, "");
      await unlink(probe);
    }
  }

  /**
   * Resolve a vault-relative directory and prove it cannot escape the root.
   *
   * Two passes, in this order and not the other:
   *   1. lexical, BEFORE creating anything, so a traversal path never gets to
   *      mkdir its way out of the vault before being rejected.
   *   2. symlink-resolved, after, because the lexical pass cannot see that an
   *      existing Inbox is a symlink to somewhere else entirely.
   */
  private async confineDir(relDir: string): Promise<string> {
    const realRoot = await realpath(this.root);

    const target = resolve(realRoot, relDir);
    if (target !== realRoot && !target.startsWith(realRoot + sep)) {
      throw new Error(`path escapes vault root: ${relDir}`);
    }

    // Walk one path segment at a time instead of mkdir(recursive: true) on
    // the whole thing: a symlink planted at any intermediate segment is
    // caught here before anything is created past it. A single recursive
    // mkdir follows such a symlink and creates real directories outside the
    // vault before the final check below ever runs.
    const relParts = relDir.split(sep).filter(Boolean);
    let cur = realRoot;
    for (const part of relParts) {
      const next = join(cur, part);
      try {
        const st = await lstat(next);
        if (st.isSymbolicLink()) {
          const resolved = await realpath(next);
          if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) {
            throw new Error(`path escapes vault root: ${relDir}`);
          }
          cur = resolved;
          continue;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        try {
          await mkdir(next);
        } catch (e2) {
          if ((e2 as NodeJS.ErrnoException).code !== "EEXIST") throw e2;
        }
      }
      cur = next;
    }

    const realTarget = await realpath(cur);
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error(`path escapes vault root: ${relDir}`);
    }
    return realTarget;
  }

  /**
   * Filenames are generated from the clock, never from the transcript.
   * This defends anyway, because later features will want titles.
   */
  private safeName(name: string): string {
    const cleaned = basename(name)
      .replace(/[\u0000-\u001F\u007F]/g, "")
      .replace(/[/\\:*?"<>|]/g, "-")
      .replace(/^\.+/, "")
      .slice(0, 120)
      .trim();
    if (!cleaned || cleaned === "." || cleaned === "..") throw new Error("unsafe filename");
    return cleaned;
  }

  async capture(input: CaptureInput): Promise<WriteResult> {
    const dir = await this.confineDir(this.inbox);
    const stamp = localStamp(input.at);
    const body = renderNote(input);
    const bytes = Buffer.byteLength(body, "utf8");

    if (this.dryRun) {
      let previewName = this.safeName(`${stamp}-voice.md`);
      let pn = 1;
      while (existsSync(join(dir, previewName))) {
        previewName = this.safeName(`${stamp}-voice-${++pn}.md`);
      }
      const relPath = join(this.inbox, previewName);
      console.log(`${amber("[dry-run]")} would write ${bytes}B to ${relPath}`);
      return { path: join(dir, previewName), relPath, bytes, dryRun: true };
    }

    // Reserve a filename with an O_EXCL create: two concurrent captures in
    // the same clock-minute race to create the same name, and the create
    // itself is atomic at the OS level, so the loser is guaranteed to move
    // on to the next name instead of silently overwriting the winner's note
    // at rename time (which an existsSync-then-rename check cannot promise).
    let name = this.safeName(`${stamp}-voice.md`);
    let n = 1;
    let abs = join(dir, name);
    for (;;) {
      try {
        const fh = await open(abs, "wx");
        await fh.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        name = this.safeName(`${stamp}-voice-${++n}.md`);
        abs = join(dir, name);
      }
    }
    const relPath = join(this.inbox, name);

    // Atomic write: temp file in the SAME directory, fsync, then rename over
    // the reservation above. A syncing daemon or Obsidian must never observe
    // a half-written note.
    const tmp = join(dir, `.tama-tmp-${process.pid}-${crypto.randomUUID()}`);
    const fh = await open(tmp, "w");
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, abs);

    try {
      await this.journal({ op: "capture", at: input.at, relPath, bytes, source: input.source });
    } catch (e) {
      // The note is already durably written. Losing the audit line is a
      // lesser failure than rejecting here: the caller's idempotency key
      // would be released and a retry would write a second, duplicate note.
      console.error(`journal write failed for ${relPath}:`, e);
    }
    return { path: abs, relPath, bytes, dryRun: false };
  }

  /**
   * Import one existing Markdown note verbatim at its vault-relative path.
   *
   * Imports are distinct from captures: preserving folders and filenames is
   * what keeps wiki-links useful. They are still append-only. Identical files
   * are idempotently skipped and a different existing file is never replaced.
   */
  /**
   * Append to a note, creating it if it does not exist.
   *
   * Distinct from `capture`, which decides the filename, and from
   * `importMarkdown`, which refuses to touch an existing file. This is the
   * write an agent wants: a path it chose, added to over and over, as a session
   * log or a running page.
   *
   * Append rather than rewrite because the caller does not hold the file. Two
   * agents finishing at once, or one retrying, must not lose the other's entry,
   * and a read-modify-write would do exactly that.
   */
  async appendMarkdown(relPath: string, text: string): Promise<WriteResult & { created: boolean }> {
    const { dir: relDir, name } = this.checkedPath(relPath);
    const body = text.endsWith("\n") ? text : `${text}\n`;
    const bytes = Buffer.byteLength(body, "utf8");

    if (this.dryRun) {
      const abs = join(resolve(await realpath(this.root), relDir), name);
      console.log(`${amber("[dry-run]")} would append ${bytes}B to ${relPath}`);
      return { path: abs, relPath, bytes, dryRun: true, created: false };
    }

    const dir = await this.confineDir(relDir);
    const abs = join(dir, name);

    let created = false;
    try {
      const st = await lstat(abs);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`append destination is not a regular file: ${relPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      created = true;
    }

    // O_APPEND, so concurrent writers interleave whole entries instead of
    // overwriting each other. fsync because a note that is only in the page
    // cache is a note that a power cut never had.
    const fh = await open(abs, "a");
    try {
      await fh.writeFile(body, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }

    try {
      await this.journal({ op: "append", at: new Date(), relPath, bytes, source: "tama-append" });
    } catch (error) {
      console.error(`journal write failed for appended ${relPath}:`, error);
    }
    return { path: abs, relPath, bytes, dryRun: false, created };
  }

  /**
   * The path checks shared by every caller-chosen path.
   *
   * Lifted out of importMarkdown rather than duplicated: this is the security
   * surface for anything that lets a client name a file, and two copies of it
   * would eventually disagree.
   */
  private checkedPath(relPath: string): { dir: string; name: string } {
    const parts = relPath.split("/");
    if (
      parts.length === 0 ||
      parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[\\\u0000-\u001f\u007f]/.test(part))
    ) {
      throw new Error(`unsafe path: ${relPath}`);
    }
    const name = parts.at(-1)!;
    if (!name.toLowerCase().endsWith(".md") || this.safeName(name) !== name) {
      throw new Error(`unsafe Markdown filename: ${relPath}`);
    }
    return { dir: parts.slice(0, -1).join(sep), name };
  }

  async importMarkdown(relPath: string, text: string): Promise<ImportResult> {
    const parts = relPath.split("/");
    if (
      parts.length === 0 ||
      parts.some((part) => !part || part === "." || part === ".." || part.startsWith(".") || /[\\\u0000-\u001f\u007f]/.test(part))
    ) {
      throw new Error(`unsafe import path: ${relPath}`);
    }
    const name = parts.at(-1)!;
    if (!name.toLowerCase().endsWith(".md") || this.safeName(name) !== name) {
      throw new Error(`unsafe Markdown filename: ${relPath}`);
    }

    const realRoot = await realpath(this.root);
    const relDir = parts.slice(0, -1).join(sep);
    const lexicalDir = resolve(realRoot, relDir);
    if (lexicalDir !== realRoot && !lexicalDir.startsWith(realRoot + sep)) {
      throw new Error(`path escapes vault root: ${relPath}`);
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (this.dryRun) {
      const abs = join(lexicalDir, name);
      console.log(`${amber("[dry-run]")} would import ${bytes}B to ${relPath}`);
      return { path: abs, relPath, bytes, dryRun: true, imported: false };
    }

    const dir = await this.confineDir(relDir);
    const abs = join(dir, name);
    try {
      const existingStat = await lstat(abs);
      if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
        throw new Error(`import destination is not a regular file: ${relPath}`);
      }
      const existing = await readFile(abs, "utf8");
      if (existing === text) return { path: abs, relPath, bytes, dryRun: false, imported: false };
      throw new Error(`import would overwrite a different note: ${relPath}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // A fully-written, fsynced temp file is hard-linked into place. link(2)
    // fails on EEXIST, so even a concurrent writer cannot be overwritten.
    const tmp = join(dir, `.tama-import-${process.pid}-${crypto.randomUUID()}`);
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(text, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await link(tmp, abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`import destination appeared concurrently: ${relPath}`);
      }
      throw error;
    } finally {
      await unlink(tmp).catch(() => {});
    }

    try {
      await this.journal({ op: "import", at: new Date(), relPath, bytes, source: "tama-import" });
    } catch (error) {
      console.error(`journal write failed for imported ${relPath}:`, error);
    }
    return { path: abs, relPath, bytes, dryRun: false, imported: true };
  }

  /** Invariant 4: every write is auditable without reading source code. */
  private async journal(e: { op: "capture" | "import" | "append"; at: Date; relPath: string; bytes: number; source: string }) {
    const dir = await this.confineDir(".tama");
    const line = JSON.stringify({
      ts: e.at.toISOString(),
      op: e.op,
      path: e.relPath,
      bytes: e.bytes,
      source: e.source,
    });
    await appendFile(join(dir, "write-journal.jsonl"), line + "\n", "utf8");
  }
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Local time, not UTC. A note taken at 11pm belongs to that day. */
function localStamp(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function tzOffset(d: Date) {
  const m = -d.getTimezoneOffset();
  const s = m >= 0 ? "+" : "-";
  return `${s}${pad(Math.floor(Math.abs(m) / 60))}:${pad(Math.abs(m) % 60)}`;
}

/**
 * The transcript is written verbatim into the body. It is never parsed,
 * never interpolated into a path, and never reaches a shell.
 */
function renderNote(input: CaptureInput): string {
  const d = input.at;
  const iso =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tzOffset(d)}`;
  return [
    "---",
    "source: voice",
    `captured: ${iso}`,
    `client: ${JSON.stringify(input.source)}`,
    "---",
    "",
    input.text.trim(),
    "",
  ].join("\n");
}
