/**
 * Notes chosen by path, not found by score.
 *
 * `GrepRetriever` is the only way anything reaches the model, and `View` can
 * only narrow that path, never widen it. So everything the model knows about a
 * vault, it knows because a keyword happened to match. That works for "what did
 * I decide about the mic gain" and fails for every question whose answer depends
 * on how the vault is *arranged* rather than on what a note *says*: which file
 * is canonical, which file is regenerated and disposable, which one wins when
 * two recent notes disagree.
 *
 * `TEMPORAL_RULES` has exactly one conflict rule, prefer the newer note, and
 * recency is the wrong tiebreak when the fresher file is a daily scratch file
 * and the older one is the source of truth. Observed on a real vault: a root
 * conventions file said one note held current state and another was overwritten
 * every morning and disposable by design. Asked what was current, the model
 * cited the disposable one, because it had scored higher.
 *
 * Retrieval cannot fix that, and not for want of tuning:
 *
 *   - a conventions file shares almost no vocabulary with any question asked of
 *     it, and `W_COVERAGE` is the heaviest signal by a factor of four. It is
 *     unfindable by construction.
 *   - scoring it would spend one of `ask.maxChunks` slots on it, taking a slot
 *     from the notes that hold the answer.
 *   - the busier and more contradictory the vault, the more those slots fill
 *     with substantive matches. The context that resolves conflicts would drop
 *     out at exactly the moment there are conflicts to resolve.
 *
 * ## Two roles, and why they are not a caching split
 *
 * `conventions` is durable structure. `state` is what is live right now. The
 * distinction earns its keep in the prompt, where "this describes how my notes
 * are organised" and "this is what I am doing today" want different framing and
 * a different rule against recency.
 *
 * It was going to be a caching split as well, on the reasoning that a stable
 * file could ride the cacheable prefix (#24) while a daily one could not. It
 * cannot: the only cache breakpoint is on the Anthropic adapter's `system`
 * parameter, and a pinned file may never have system authority (see below). So
 * both roles ride in the user message and neither is cached today. Caching them
 * would mean block-form messages with a second breakpoint on the Anthropic path
 * only, which is a separate change.
 *
 * ## A pinned note is still untrusted
 *
 * `ARCHITECTURE.md` says why: a vault can be synced from elsewhere or filled by
 * anyone who can reach `/capture`, so a note is free text that may be shaped
 * like an instruction. Pinning a file into every single request makes it the
 * most valuable file in the vault to an attacker, so the naive version of this
 * feature, which reads the conventions file into the system prompt, hands that
 * attacker system authority on every question.
 *
 * So a pin is fenced as data in the user message, like an excerpt. It may
 * establish facts about how the vault is arranged. It may not reach the ground
 * rules. That is the same positioning `customVoice` already relies on: an
 * owner-written string is assembled after the rules so a description of how to
 * talk cannot talk itself out of what may not change.
 */

import { visible, type View } from "./views.ts";

export type PinRole = "conventions" | "state";

/** Vault-relative paths to pin, by role. Both optional; absent means none. */
export type PinPaths = { conventions?: string[]; state?: string[] };

export type PinnedNote = { role: PinRole; path: string; text: string; truncated: boolean };

/**
 * The one thing this needs from a vault, so a test can supply it and so this
 * module cannot reach any other part of `Vault`. Reads still go through the
 * adapter that owns every invariant; this is the shape of the read, not a
 * second way to do one.
 */
export interface PinReader {
  readNote(
    relPath: string,
    maxBytes?: number,
  ): Promise<{ text: string; bytes: number; truncated: boolean } | null>;
}

/**
 * Caps, because a pin is paid for on every question rather than on the ones
 * that match it.
 *
 * 32 KiB per note takes a real conventions file whole. A large "what is live
 * now" file will be cut, which is why truncation is reported rather than
 * hidden: a pin silently halved reads to the owner as a model that ignored
 * half their instructions.
 *
 * The total is the number that actually protects the bill. Eight notes at the
 * per-note cap would be 256 KiB of input on every message, so the budget is
 * spent in order and the overflow is dropped loudly.
 */
export const PIN_MAX_BYTES = 32 * 1024;
export const PIN_MAX_TOTAL_BYTES = 64 * 1024;
export const PIN_MAX_NOTES = 8;

/** Conventions before state: structure, then what is happening inside it. */
const ROLE_ORDER: PinRole[] = ["conventions", "state"];

/**
 * Read the pinned notes, in role order, within budget.
 *
 * Every skip is announced through `onNotice` rather than swallowed. A pin that
 * does nothing and says nothing is worse than no pin at all, because the owner
 * concludes the setting works and reasons about answers as though the file were
 * being read.
 *
 * A missing note is not an error. A pin naming a note the owner has not written
 * yet is a configuration to grow into, and failing a question over it would
 * make the whole feature hostile to set up.
 */
export async function loadPinnedNotes(
  reader: PinReader,
  paths: PinPaths | undefined,
  view?: View,
  onNotice?: (message: string) => void,
): Promise<PinnedNote[]> {
  if (!paths) return [];

  const notice = (message: string) => onNotice?.(message);
  const out: PinnedNote[] = [];
  const seen = new Set<string>();
  let spent = 0;

  for (const role of ROLE_ORDER) {
    for (const path of paths[role] ?? []) {
      const relPath = path.trim();
      if (!relPath) continue;

      // One note, one pin, even if it is named in both roles. Reading it twice
      // would double its cost and let the same text arrive under two different
      // framings, one of which says it is durable structure and one of which
      // says it is live state.
      if (seen.has(relPath)) {
        notice(`pin ${relPath} is listed more than once, so it is pinned as ${out.find((p) => p.path === relPath)!.role}`);
        continue;
      }
      seen.add(relPath);

      if (out.length >= PIN_MAX_NOTES) {
        notice(`pin ${relPath} skipped: already at the ceiling of ${PIN_MAX_NOTES} pinned notes`);
        continue;
      }

      // Before the read, not after. A view is what an audience may see, and a
      // filename alone can disclose: `NO_CITE_RULES` exists because naming a
      // file names the thing it is about. A conventions file listing every
      // folder would hand a scoped group the shape of a vault it was given one
      // slice of.
      if (!visible(relPath, view)) {
        notice(`pin ${relPath} skipped: this audience's view does not include it`);
        continue;
      }

      let read;
      try {
        read = await reader.readNote(relPath, PIN_MAX_BYTES);
      } catch (error) {
        // An unsafe or escaping path throws in the vault adapter, which is
        // where that judgement belongs. It must not fail the question: the
        // owner asked something, and a bad line of config is not their fault
        // at the moment they asked it.
        notice(`pin ${relPath} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }

      if (read === null) {
        notice(`pin ${relPath} is not in the vault yet`);
        continue;
      }
      if (!read.text.trim()) {
        notice(`pin ${relPath} is empty`);
        continue;
      }

      const remaining = PIN_MAX_TOTAL_BYTES - spent;
      if (remaining <= 0) {
        notice(`pin ${relPath} skipped: the ${PIN_MAX_TOTAL_BYTES / 1024}KB pin budget is already spent`);
        continue;
      }

      // Cut on a character boundary by slicing the decoded text rather than the
      // buffer. `readNote` already capped the bytes; this only applies when the
      // running total, not this one note, is what ran out.
      let text = read.text;
      let truncated = read.truncated;
      if (read.bytes > remaining) {
        text = text.slice(0, remaining);
        truncated = true;
      }
      spent += Buffer.byteLength(text, "utf8");

      if (truncated) {
        notice(`pin ${relPath} was cut to fit; it is longer than the pin budget`);
      }
      out.push({ role, path: relPath, text, truncated });
    }
  }

  return out;
}

const FENCE: Record<PinRole, string> = {
  conventions: "VAULT GUIDE",
  state: "CURRENT STATE",
};

/**
 * Fenced like an excerpt, and labelled unlike one.
 *
 * The markers differ from `BEGIN NOTE` on purpose. A pin and an excerpt are
 * both untrusted note text, so they get the same kind of boundary, but they are
 * not the same kind of evidence: one was chosen because the owner said it
 * always matters, the other because it matched some words. A model that cannot
 * tell them apart cannot apply the rule that the guide outranks recency.
 */
export function renderPinnedNotes(pins: PinnedNote[]): string {
  return pins
    .map((p) => {
      const cut = p.truncated ? ", truncated" : "";
      return [
        `--- BEGIN ${FENCE[p.role]} (${p.path}${cut}) ---`,
        p.text.trim(),
        `--- END ${FENCE[p.role]} ---`,
      ].join("\n");
    })
    .join("\n\n");
}
