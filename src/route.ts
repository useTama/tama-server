/**
 * Post-processing: turn the Inbox into a second brain.
 *
 * Capture is deliberately model-free, so every thought lands in one place as
 * `Inbox/<date>-<time>-voice.md`. That is right for capture and useless as a
 * brain: the notes are named after the minute they arrived, nothing links to a
 * timestamp, and a vault of six hundred dated files has no structure to walk.
 *
 * So the Inbox is staging, not storage. A cycle reads what is sitting there,
 * decides which note each capture belongs in, rewrites that note to include it,
 * and deletes the capture. The raw transcript is not lost: the vault is a git
 * repository, tama commits its own writes, and the cycle commits before it
 * rewrites anything, so every pre-cycle version of every note is in history.
 * That is the whole safety story, and it is why emptying the Inbox is allowed.
 *
 * Three rules the model works under, each of them load-bearing:
 *
 * **It files, it does not invent taxonomy.** A destination is an existing note,
 * or a new note one level inside an existing top-level folder. Left free, a
 * model will grow `Random/`, `Misc/` and `Notes/` beside `Projects/` within a
 * week and the folder tree stops meaning anything.
 *
 * **It integrates, it does not append.** Appending a dated section to a topic
 * note reproduces the Inbox inside the note. The whole point is that the note
 * reads as one thing afterwards.
 *
 * **A note's links survive.** The links are the brain. A rewrite that drops
 * `[[...]]` is rejected outright rather than trusted, because a model
 * summarising for brevity will quietly take them out.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Llm } from "./llm.ts";
import type { Vault } from "./vault.ts";
import { recordFailure } from "./digest.ts";

export type RouteConfig = {
  /** How often the cycle runs. */
  everyMinutes: number;
  /**
   * How long a capture rests before it is eligible. A note is written, then
   * the debounced commit runs; grabbing it in between means rewriting a note
   * whose previous version was never committed, which is the one case where a
   * bad pass is not revertible.
   */
  minAgeSeconds: number;
  /** Captures per cycle. A backlog drains over several cycles rather than in one bill. */
  maxPerSweep: number;
  /** Below this, the capture stays in the Inbox. Guessing is worse than waiting. */
  minConfidence: number;
  /** Attempts before a capture is left alone, so an unfileable note is not billed forever. */
  maxTries: number;
  /** The living note: what is open right now. Rewritten whole, every cycle. */
  nowNote: string;
};

export const ROUTE_DEFAULTS: RouteConfig = {
  everyMinutes: 15,
  minAgeSeconds: 120,
  maxPerSweep: 12,
  minConfidence: 0.6,
  maxTries: 3,
  nowNote: "now.md",
};

/** Where a capture may go, and what already exists to put it with. */
export type Universe = {
  /** Every note outside the Inbox, vault-relative. The first choice for a destination. */
  notes: string[];
  /** Top-level folders that exist. A new note may only be created inside one. */
  topLevel: string[];
};

export type Plan = {
  /** Vault-relative destination, or null when nothing fits. */
  destination: string | null;
  title: string;
  confidence: number;
  /** Tasks, reminders and open questions, in the speaker's own words. */
  openLoops: string[];
  reason: string;
};

/**
 * Drain a completion into a string.
 *
 * `Llm` exposes streaming only, because answering a question should start
 * before it finishes. Filing a note has no reader waiting on the first token.
 */
async function complete(llm: Llm, system: string, user: string): Promise<string> {
  let out = "";
  for await (const delta of llm.stream({ system, messages: [{ role: "user", content: user }] })) {
    out += delta;
  }
  return out;
}

/**
 * The first JSON object in a completion.
 *
 * Told to answer with JSON and nothing else, a model still fences it, prefaces
 * it with "Here is the JSON:", or does both. Brace-matching the first object is
 * shorter than any amount of asking nicely in the prompt.
 */
export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** A capture's body, without the frontmatter capture wrote. */
export function noteBody(text: string): string {
  if (!text.startsWith("---\n")) return text.trim();
  const end = text.indexOf("\n---", 4);
  return end < 0 ? text.trim() : text.slice(end + 4).trim();
}

/** Every `[[link]]` in a note, deduped. These are the edges of the graph. */
export function wikilinks(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) found.add(m[1]!.trim().toLowerCase());
  return [...found];
}

/**
 * What exists to file into.
 *
 * Walks the vault once, skipping the Inbox and dot-directories. Depth-limited
 * because the list goes into a prompt: a deep vault would spend the context on
 * paths instead of on the note being filed.
 */
export async function universe(
  root: string,
  inbox: string,
  opts: { maxDepth?: number; maxNotes?: number } = {},
): Promise<Universe> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxNotes = opts.maxNotes ?? 400;
  const notes: string[] = [];
  const topLevel: string[] = [];

  const walk = async (rel: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (child === inbox) continue;
        if (!rel) topLevel.push(e.name);
        if (depth < maxDepth) await walk(child, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
        if (notes.length < maxNotes) notes.push(child);
      }
    }
  };

  await walk("", 0);
  return { notes, topLevel };
}

/**
 * Accept a destination, or say why not.
 *
 * The model picks from a list, but a model that picks from a list still returns
 * things that were not on it. Everything a rewrite touches is checked here
 * first, so `Projects/../../etc/x.md` and a freshly invented `Misc/` fail the
 * same way: as a refusal to file, not as a write.
 */
export function checkDestination(
  dest: string,
  u: Universe,
  inbox: string,
): { ok: true } | { ok: false; why: string } {
  const parts = dest.split("/");
  if (parts.length < 2) return { ok: false, why: "a destination must live in a folder, not the vault root" };
  if (!dest.toLowerCase().endsWith(".md")) return { ok: false, why: "not a Markdown path" };
  if (parts.some((p) => !p || p === "." || p === ".." || p.startsWith("."))) {
    return { ok: false, why: "unsafe path segment" };
  }
  if (parts[0] === inbox) return { ok: false, why: "the Inbox is staging, not a destination" };
  if (u.notes.includes(dest)) return { ok: true };
  // A new note is allowed one level inside a folder that already exists. That
  // is enough to start Projects/remote-star without letting the model grow a
  // fourth top-level folder that means the same as one of the first three.
  if (!u.topLevel.includes(parts[0]!)) {
    return { ok: false, why: `${parts[0]} is not an existing top-level folder` };
  }
  if (parts.length > 3) return { ok: false, why: "a new note may be at most one folder deep inside its root" };
  return { ok: true };
}

const TRIAGE_SYSTEM = `You file one voice capture into somebody's existing Markdown vault. You decide where it belongs. You do not write the note.

Rules:
- Prefer a note that already exists, from the list you are given.
- When nothing fits, you may name a new note one level inside an existing top-level folder: "<ExistingFolder>/<slug>/notes.md". Slugs are lowercase and hyphenated.
- Never invent a top-level folder. Never choose the Inbox. Never choose the vault root.
- openLoops: anything the speaker has to come back to - a task, a decision not yet made, a question. Their words, not yours. Empty when there are none.
- confidence is how sure you are of the destination, 0 to 1. If the capture is small talk, a test, or too vague to place, set destination to null. Leaving it in the Inbox is better than filing it wrong.

Answer with one JSON object and nothing else:
{"destination": string|null, "title": string, "confidence": number, "openLoops": string[], "reason": string}`;

export async function planCapture(
  llm: Llm,
  input: { capture: string; universe: Universe; inbox: string },
): Promise<Plan> {
  const { notes, topLevel } = input.universe;
  const user = [
    "Existing notes:",
    notes.length ? notes.map((n) => `- ${n}`).join("\n") : "(none yet)",
    "",
    "Existing top-level folders:",
    topLevel.length ? topLevel.map((f) => `- ${f}`).join("\n") : "(none yet)",
    "",
    "The capture:",
    input.capture,
  ].join("\n");

  const raw = firstJsonObject(await complete(llm, TRIAGE_SYSTEM, user)) as Partial<Plan> | null;
  const loops = Array.isArray(raw?.openLoops) ? raw!.openLoops.map((l) => String(l)).filter(Boolean) : [];
  const dest = typeof raw?.destination === "string" ? raw.destination.trim() : null;
  const plan: Plan = {
    destination: dest || null,
    title: String(raw?.title ?? "").trim(),
    confidence: Number.isFinite(raw?.confidence) ? Number(raw!.confidence) : 0,
    openLoops: loops,
    reason: String(raw?.reason ?? "").trim(),
  };

  // A rejected destination is not a rejected capture: the open loops it found
  // are still worth having, so the plan comes back unfiled rather than thrown.
  if (plan.destination) {
    const check = checkDestination(plan.destination, input.universe, input.inbox);
    if (!check.ok) return { ...plan, destination: null, confidence: 0, reason: `rejected: ${check.why}` };
  }
  return plan;
}

const INTEGRATE_SYSTEM = `You maintain one note in somebody's second brain. You are given the note as it stands and a new capture that belongs in it. Return the complete new text of the note.

Rules:
- Integrate the new information where it belongs in the existing structure. Never append a dated section - a note is not a log.
- Remove only what the new information supersedes. Keep everything else, in the author's own words.
- Every [[wikilink]] already in the note must still be there.
- Keep their voice, their headings and their formatting. Do not tidy what you were not asked to change.
- Never invent a fact, a date or a name. Where the capture is ambiguous, record it plainly instead of resolving it.
- Return the Markdown only. No code fences, no explanation.`;

/**
 * Rewrite one note to include a capture.
 *
 * The link check is here rather than left to the prompt because this is the
 * failure that matters: a model asked to be concise drops `[[...]]` first, and
 * a vault that loses its edges is a folder of files.
 */
export async function integrateNote(
  llm: Llm,
  input: { relPath: string; current: string; capture: string; title?: string },
): Promise<{ text: string } | { error: string }> {
  const user = [
    `Note: ${input.relPath}`,
    "",
    input.current.trim() || "(this note does not exist yet - write it from scratch)",
    "",
    "--- new capture ---",
    input.title ? `Subject: ${input.title}` : "",
    input.capture,
  ].filter(Boolean).join("\n");

  const text = stripFences(await complete(llm, INTEGRATE_SYSTEM, user));
  if (!text.trim()) return { error: "the model returned nothing" };

  const before = wikilinks(input.current);
  const after = new Set(wikilinks(text));
  const dropped = before.filter((l) => !after.has(l));
  if (dropped.length) return { error: `the rewrite dropped links: ${dropped.join(", ")}` };
  return { text };
}

const NOW_SYSTEM = `You maintain now.md: what this person has open right now. It is the file they open to remember where they were.

Rules:
- Return the complete new now.md, Markdown only.
- Short enough to read in ten seconds. If it does not fit on a screen, it is not a "now".
- Add the new open loops. Merge them into an existing line rather than listing the same thing twice.
- Drop what the new information shows as done, decided or abandoned.
- Every [[wikilink]] already in the file must still be there.
- Keep their wording. This is their list, not your summary of it.`;

export async function refreshNow(
  llm: Llm,
  input: { current: string; loops: string[] },
): Promise<{ text: string } | { error: string }> {
  if (!input.loops.length) return { error: "nothing new to add" };
  const user = [
    "now.md as it stands:",
    input.current.trim() || "(empty)",
    "",
    "Open loops picked up from new captures:",
    input.loops.map((l) => `- ${l}`).join("\n"),
  ].join("\n");

  const text = stripFences(await complete(llm, NOW_SYSTEM, user));
  if (!text.trim()) return { error: "the model returned nothing" };
  const before = wikilinks(input.current);
  const after = new Set(wikilinks(text));
  const dropped = before.filter((l) => !after.has(l));
  if (dropped.length) return { error: `the rewrite dropped links: ${dropped.join(", ")}` };
  return { text };
}

/**
 * Models fence Markdown even when told not to, and a fence written into a note
 * turns the whole thing into a code block in Obsidian.
 */
export function stripFences(text: string): string {
  const t = text.trim();
  if (!t.startsWith("```")) return t;
  const firstNewline = t.indexOf("\n");
  if (firstNewline < 0) return t;
  const end = t.lastIndexOf("```");
  return (end > firstNewline ? t.slice(firstNewline + 1, end) : t.slice(firstNewline + 1)).trim();
}

/** A capture waiting in the Inbox. */
export type Waiting = { relPath: string; name: string; text: string; ageSeconds: number };

export async function waiting(
  root: string,
  inbox: string,
  now: Date = new Date(),
): Promise<Waiting[]> {
  let entries;
  try {
    entries = await readdir(join(root, inbox), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Waiting[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isFile() || e.name.startsWith(".") || !e.name.toLowerCase().endsWith(".md")) continue;
    const abs = join(root, inbox, e.name);
    try {
      const [text, st] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
      out.push({
        relPath: `${inbox}/${e.name}`,
        name: e.name,
        text,
        ageSeconds: Math.max(0, (now.getTime() - st.mtimeMs) / 1000),
      });
    } catch {
      // A note can vanish between the listing and the read: a concurrent
      // cycle, or the owner filing it by hand. Both are fine.
    }
  }
  return out;
}

/** What one cycle did. Feeds the log line and the digest. */
export type RouteReport = {
  filed: { capture: string; destination: string; created: boolean }[];
  /** Placed nowhere, on purpose: too vague, or nothing fits yet. */
  unfiled: { capture: string; why: string }[];
  /** Tried and went wrong. These are worth telling someone about. */
  failed: { capture: string; why: string }[];
  nowUpdated: boolean;
  /** Captures left for a later cycle because this one was full. */
  remaining: number;
};

export type RouteDeps = {
  vault: Vault;
  db: Database;
  llm: Llm;
  /** Absolute vault root, for reading notes the vault has no getter for. */
  root: string;
  inbox: string;
  config: RouteConfig;
  onWrite?: () => void;
};

/**
 * One pass over the Inbox.
 *
 * The commit at the top is not housekeeping, it is the precondition for
 * everything below it. Rewriting a note is only reversible because the version
 * before the rewrite is in git, so a cycle that cannot commit does not get to
 * rewrite. That is also why a capture rests for a couple of minutes first: a
 * note written and filed inside one debounce window would be rewritten from a
 * state git never saw.
 *
 * Nothing here throws. A cycle runs unattended on a timer, and a provider that
 * rate-limits at three in the morning must cost one skipped pass, not a dead
 * server and an Inbox nobody is watching.
 */
export async function routeOnce(deps: RouteDeps): Promise<RouteReport> {
  const { vault, db, llm, root, inbox, config } = deps;
  const report: RouteReport = { filed: [], unfiled: [], failed: [], nowUpdated: false, remaining: 0 };

  const pre = await vault.commit("tama: before routing").catch((e: unknown) => ({
    committed: false,
    detail: e instanceof Error ? e.message : String(e),
  }));
  // "dry run" passes because nothing is written in that mode, so there is
  // nothing for a commit to have protected.
  if (!pre.committed && !/nothing to commit|no changes|dry run/i.test(pre.detail)) {
    // Refusing here is the whole safety model. Filing without a commit means
    // the pre-rewrite note exists only in the file that is about to be
    // overwritten.
    recordFailure(db, { kind: "route-blocked", detail: `not committing, so not rewriting: ${pre.detail}`, source: "route" });
    return report;
  }

  const tries = db.query<{ rel_path: string; tries: number }, []>(
    "SELECT rel_path, tries FROM route_attempts",
  ).all();
  const triedByPath = new Map(tries.map((r) => [r.rel_path, r.tries]));

  const all = await waiting(root, inbox);
  const eligible = all.filter(
    (w) => w.ageSeconds >= config.minAgeSeconds && (triedByPath.get(w.relPath) ?? 0) < config.maxTries,
  );
  const batch = eligible.slice(0, config.maxPerSweep);
  report.remaining = eligible.length - batch.length;
  if (!batch.length) return report;

  const u = await universe(root, inbox);
  const known = new Set(u.notes);
  const loops: string[] = [];

  for (const w of batch) {
    const capture = noteBody(w.text);
    if (!capture) {
      // An empty capture cannot be filed and will never become fileable.
      noteAttempt(db, w.relPath, "empty capture", config.maxTries);
      report.unfiled.push({ capture: w.relPath, why: "empty" });
      continue;
    }

    try {
      const plan = await planCapture(llm, { capture, universe: { notes: [...known], topLevel: u.topLevel }, inbox });
      if (plan.openLoops.length) loops.push(...plan.openLoops);

      if (!plan.destination || plan.confidence < config.minConfidence) {
        const why = plan.destination
          ? `confidence ${plan.confidence.toFixed(2)} below ${config.minConfidence}`
          : plan.reason || "nothing fits yet";
        noteAttempt(db, w.relPath, why, config.maxTries);
        report.unfiled.push({ capture: w.relPath, why });
        continue;
      }

      const dest = plan.destination;
      const exists = known.has(dest);
      const current = exists ? await readFile(join(root, dest), "utf8").catch(() => "") : "";

      const rewritten = await integrateNote(llm, { relPath: dest, current, capture, title: plan.title });
      if ("error" in rewritten) {
        noteAttempt(db, w.relPath, rewritten.error, config.maxTries);
        report.failed.push({ capture: w.relPath, why: rewritten.error });
        continue;
      }

      // A destination that does not exist yet has to be created, and
      // replaceMarkdown deliberately refuses to create: a rewrite of a missing
      // note means the path was resolved wrong.
      if (exists) await vault.replaceMarkdown(dest, rewritten.text);
      else await vault.appendMarkdown(dest, rewritten.text);
      known.add(dest);

      // Only now. The capture is gone from the Inbox once its content is
      // somewhere else, never before, so a crash in between leaves a duplicate
      // rather than a hole.
      await vault.removeNote(w.relPath);
      db.run("DELETE FROM route_attempts WHERE rel_path = ?", [w.relPath]);
      report.filed.push({ capture: w.relPath, destination: dest, created: !exists });
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      noteAttempt(db, w.relPath, why, config.maxTries);
      report.failed.push({ capture: w.relPath, why });
    }
  }

  if (loops.length) {
    try {
      const nowPath = config.nowNote;
      const current = await readFile(join(root, nowPath), "utf8").catch(() => "");
      const next = await refreshNow(llm, { current, loops });
      if ("error" in next) {
        report.failed.push({ capture: nowPath, why: next.error });
      } else if (current.trim()) {
        await vault.replaceMarkdown(nowPath, next.text);
        report.nowUpdated = true;
      } else {
        await vault.appendMarkdown(nowPath, next.text);
        report.nowUpdated = true;
      }
    } catch (e) {
      report.failed.push({ capture: config.nowNote, why: e instanceof Error ? e.message : String(e) });
    }
  }

  for (const f of report.failed) {
    recordFailure(db, { kind: "route-failed", detail: `${f.capture}: ${f.why}`, source: "route" });
  }
  if (report.filed.length || report.nowUpdated) {
    await vault.commit(`tama: filed ${report.filed.length} capture${report.filed.length === 1 ? "" : "s"}`)
      .catch((e: unknown) => console.error("could not commit the routing pass:", e));
    deps.onWrite?.();
  }
  return report;
}

/**
 * Count a failed attempt, and say so once it is the last one.
 *
 * A capture nothing can place would otherwise be triaged on every cycle
 * forever. Three goes is enough to ride out a bad answer or a rate limit; past
 * that it wants a human, and the digest is where a human finds out.
 */
function noteAttempt(db: Database, relPath: string, why: string, maxTries: number): void {
  db.run(
    `INSERT INTO route_attempts (rel_path, tries, last_at, last_why) VALUES (?, 1, ?, ?)
     ON CONFLICT(rel_path) DO UPDATE SET tries = tries + 1, last_at = excluded.last_at, last_why = excluded.last_why`,
    [relPath, new Date().toISOString(), why.slice(0, 300)],
  );
  const row = db.query<{ tries: number }, [string]>("SELECT tries FROM route_attempts WHERE rel_path = ?").get(relPath);
  if (row && row.tries >= maxTries) {
    recordFailure(db, {
      kind: "route-gave-up",
      detail: `${relPath} could not be filed after ${row.tries} tries: ${why.slice(0, 200)}`,
      source: "route",
    });
  }
}

/** Captures sitting in the Inbox that routing has given up on. */
export function stuck(db: Database, maxTries: number): { relPath: string; why: string }[] {
  return db
    .query<{ rel_path: string; last_why: string | null }, [number]>(
      "SELECT rel_path, last_why FROM route_attempts WHERE tries >= ? ORDER BY last_at DESC",
    )
    .all(maxTries)
    .map((r) => ({ relPath: r.rel_path, why: r.last_why ?? "unknown" }));
}

/**
 * Run the cycle on a timer.
 *
 * Never overlaps itself: a pass that is still waiting on a model when the next
 * tick fires would triage the same captures twice and file both copies. Skipped
 * rather than queued, because the next tick is minutes away.
 */
export function scheduleRouting(deps: RouteDeps, onFire?: (r: RouteReport) => void): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const r = await routeOnce(deps);
      onFire?.(r);
    } catch (e) {
      console.error("routing cycle failed:", e);
    } finally {
      running = false;
    }
  }, Math.max(1, deps.config.everyMinutes) * 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
