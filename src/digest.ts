import type { Database } from "bun:sqlite";
import type { Notifier } from "./notify.ts";
import { safeNotify } from "./notify.ts";

/**
 * The daily digest.
 *
 * Deliberately requires no language model. At this scope a digest is counts and
 * lists: what you captured, what failed, what is piling up. That keeps the whole
 * product at zero recurring cost, which is the point of the open-source pitch.
 *
 * The failure half matters more than the capture half. Silent failure in a
 * capture tool is the worst possible failure mode: you believe a thought is
 * saved and it is not, and you find out weeks later when you go looking for it.
 */

export type Digest = {
  since: string;
  captures: number;
  words: number;
  audioMinutes: number;
  failures: { kind: string; detail: string; at: string }[];
  quietDays: number;
};

export function buildDigest(db: Database, sinceIso: string): Digest {
  const cap = db
    .query(
      "SELECT COUNT(*) n, COALESCE(SUM(words),0) w, COALESCE(SUM(audio_secs),0) s FROM captures WHERE captured_at >= ?",
    )
    .get(sinceIso) as { n: number; w: number; s: number };

  const failures = db
    .query("SELECT kind, detail, at FROM failures WHERE at >= ? ORDER BY at DESC LIMIT 10")
    .all(sinceIso) as { kind: string; detail: string; at: string }[];

  const last = db.query("SELECT MAX(captured_at) m FROM captures").get() as { m: string | null };
  const quietDays = last.m
    ? Math.floor((Date.now() - new Date(last.m).getTime()) / 86_400_000)
    : 0;

  return {
    since: sinceIso,
    captures: cap.n,
    words: cap.w,
    audioMinutes: Math.round((cap.s / 60) * 10) / 10,
    failures,
    quietDays,
  };
}

export function renderDigest(d: Digest): { title: string; message: string; level: "info" | "warn" } {
  const lines: string[] = [];

  if (d.captures === 0) {
    lines.push(d.quietDays > 1 ? `nothing captured in ${d.quietDays} days` : "nothing captured yesterday");
  } else {
    lines.push(`${d.captures} capture${d.captures === 1 ? "" : "s"}, ${d.words} words, ${d.audioMinutes} min of audio`);
  }

  if (d.failures.length) {
    lines.push("");
    lines.push(`${d.failures.length} failure${d.failures.length === 1 ? "" : "s"}:`);
    for (const f of d.failures.slice(0, 5)) lines.push(`  ${f.kind}: ${f.detail.slice(0, 80)}`);
  }

  return {
    title: d.failures.length ? `Tama: ${d.captures} captured, ${d.failures.length} failed` : `Tama: ${d.captures} captured`,
    message: lines.join("\n"),
    level: d.failures.length ? "warn" : "info",
  };
}

/**
 * Fires once a day at a local wall-clock time. No cron dependency: compute the
 * delay to the next occurrence, sleep, repeat. Survives DST because the next
 * delay is recomputed from local time every single day rather than once.
 */
export function scheduleDigest(
  db: Database,
  notifier: Notifier,
  hhmm: string,
  onFire?: (d: Digest) => void,
): () => void {
  const [hStr, mStr] = hhmm.split(":");
  const hour = Number(hStr ?? 8);
  const minute = Number(mStr ?? 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`notify.digestAt must be HH:MM, got ${hhmm}`);
  }

  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;

  const msUntilNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  };

  const arm = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const d = buildDigest(db, since);
      const r = renderDigest(d);
      safeNotify(notifier, { level: r.level, title: r.title, message: r.message });
      onFire?.(d);
      arm();
    }, msUntilNext());
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref(): void }).unref();
  };

  arm();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function recordCapture(
  db: Database,
  e: { id: string; capturedAt: Date; notePath: string; words: number; audioSecs: number; source: string },
): void {
  db.query(
    "INSERT OR REPLACE INTO captures (id, captured_at, received_at, note_path, words, audio_secs, source) VALUES (?,?,?,?,?,?,?)",
  ).run(e.id, e.capturedAt.toISOString(), new Date().toISOString(), e.notePath, e.words, e.audioSecs, e.source);
}

export function recordFailure(
  db: Database,
  e: { kind: string; detail: string; source?: string },
): void {
  db.query("INSERT INTO failures (id, at, kind, detail, source) VALUES (?,?,?,?,?)").run(
    crypto.randomUUID(),
    new Date().toISOString(),
    e.kind,
    e.detail.slice(0, 500),
    e.source ?? null,
  );
}
