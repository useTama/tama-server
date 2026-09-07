/**
 * Work summaries, written into the vault as they happen.
 *
 * The gap this closes: the only way into the vault was speech. An agent
 * finishing a session on a repo, or a person at the end of an evening, had no
 * way to leave what happened where it could be asked about later. So "what have
 * I been doing on tama" was unanswerable by the thing whose entire job is
 * answering that.
 *
 * A session entry is one append per session, to one file per project. Not one
 * note per session: a folder of forty timestamped files is worse to read and
 * worse to retrieve from than one page in order, and the thing a person
 * actually wants is the last few entries in sequence.
 */

import type { Vault } from "./vault.ts";

export type SessionEntry = {
  project: string;
  summary: string;
  /** What actually landed. */
  shipped?: string[];
  /** What was learned, especially the non-obvious. */
  learned?: string[];
  /** What the next session should pick up. */
  next?: string[];
  at?: Date;
};

/**
 * A project name to a folder name.
 *
 * Deliberately lossy and stable: "tama-server" and "Tama Server" land in the
 * same place, because an agent and a person will type both and neither expects
 * two folders.
 */
export function projectSlug(project: string): string {
  const slug = project
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new Error("session: project name has no usable characters");
  return slug;
}

export function sessionPath(project: string): string {
  return `Projects/${projectSlug(project)}/sessions.md`;
}

/** Local time, because a session log is read by a person in their own day. */
function stamp(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The block appended for one session.
 *
 * Frontmatter only on creation, carrying `project` so retrieval can tell a
 * session log from a note that merely mentions the project. The heading is a
 * timestamp, so the file reads as a diary and the most recent entry is the last
 * thing in it.
 */
export function renderEntry(entry: SessionEntry, opts: { withFrontmatter: boolean }): string {
  const at = entry.at ?? new Date();
  const lines: string[] = [];

  if (opts.withFrontmatter) {
    lines.push("---", `project: ${entry.project}`, "kind: sessions", "---", "");
    lines.push(`# ${entry.project}`, "", "What I did, newest at the bottom.", "");
  }

  lines.push(`## ${stamp(at)}`, "");
  const summary = entry.summary.trim();
  if (summary) lines.push(summary, "");

  for (const [label, items] of [
    ["Shipped", entry.shipped],
    ["Learned", entry.learned],
    ["Next", entry.next],
  ] as const) {
    const list = (items ?? []).map((i) => i.trim()).filter(Boolean);
    if (list.length === 0) continue;
    lines.push(`**${label}**`, "");
    for (const item of list) lines.push(`- ${item}`);
    lines.push("");
  }
  return lines.join("\n");
}

export async function appendSession(
  vault: Vault,
  entry: SessionEntry,
): Promise<{ relPath: string; bytes: number; created: boolean }> {
  if (!entry.summary?.trim() && !(entry.shipped?.length || entry.learned?.length || entry.next?.length)) {
    throw new Error("session: nothing to record. give a summary, or something shipped, learned or next");
  }
  const relPath = sessionPath(entry.project);

  // Probed by appending nothing first: whether the file exists decides whether
  // this entry carries the frontmatter, and asking the vault is cheaper than
  // reimplementing its path resolution here.
  const probe = await vault.appendMarkdown(relPath, "");
  const result = await vault.appendMarkdown(
    relPath,
    renderEntry(entry, { withFrontmatter: probe.created }),
  );
  return { relPath: result.relPath, bytes: result.bytes, created: probe.created };
}
