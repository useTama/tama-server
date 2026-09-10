/**
 * What a token may do, as distinct from what it may see and who it speaks as.
 *
 * Three concepts used to share one nullable column. `audience` selected a
 * persona (voice, length, whether answers cite), *and* selected a view, *and*
 * by its mere presence meant read-only - which is how `routes.ts` came to
 * decide write access with `mayWrite: !device.audience`. That is a coincidence
 * standing in for a permission, and it had two costs.
 *
 * The first is a shape nobody could express: an agent that reads a slice of the
 * vault and files its session logs back. The most useful thing an MCP client
 * can be, and there was no token for it, because writing required having no
 * audience and having no audience meant reading everything.
 *
 * The second is the setup: to scope a coding agent you had to invent a
 * WhatsApp-shaped chat persona for it - pick a voice, pick a mention policy,
 * decide whether it cites - for something that will never speak in a room.
 *
 * So: `audience` keeps meaning persona and nothing else. A grant says what may
 * be done and where.
 *
 * ## Why operations rather than routes
 *
 * The obvious model is per-route - "may call /capture, may not call /ask" - and
 * it stopped working when `/mcp` landed. Five operations sit behind that one
 * path, so no route-shaped permission can say "may search, may not append". The
 * capabilities below name what is being done rather than which URL does it,
 * which is why the same four cover both the HTTP routes and the MCP tools.
 *
 * ## Why `ask` is separate from `read`
 *
 * Reading the vault costs nothing. `/ask` spends the owner's model budget on
 * every call, on the owner's key. An agent that may search a hundred times a
 * session should not thereby be able to spend a hundred model calls, so the
 * expensive verb is its own capability even though both start by retrieving.
 *
 * ## Why views by name and not globs here
 *
 * A grant points at views by name and `views.ts` owns what they mean. Putting
 * globs on the token would be the fourth copy of a path filter, which is the
 * drift `views.ts` exists to prevent - and the one that ends with a digest
 * quoting a note the room could not have retrieved.
 */

import type { View } from "./views.ts";

export type Capability = "capture" | "read" | "write" | "ask";

/** Order is for humans: the settings list and the `caps` column read this way. */
export const CAPABILITIES: readonly Capability[] = ["capture", "read", "write", "ask"] as const;

/**
 * What a caller may do, and where.
 *
 * `read` and `write` are undefined when unconstrained, never empty. That is not
 * a style choice: `visible()` reads `{ include: [] }` as *nothing*, because
 * `BUILTIN_VIEWS.none` is spelled that way and it is the default for a new
 * audience. An empty view meaning "everything" would invert the one view that
 * must never be wrong, so absence is how this says "no constraint".
 */
export type Grant = {
  caps: ReadonlySet<Capability>;
  read?: View;
  write?: View;
};

/** Every capability. What a token with no audience and no caps column has always had. */
export const OWNER_CAPS: ReadonlySet<Capability> = new Set(CAPABILITIES);

function isCapability(s: string): s is Capability {
  return (CAPABILITIES as readonly string[]).includes(s);
}

/**
 * Parse the `caps` column. NULL and empty both mean "unrestricted".
 *
 * An unknown capability throws rather than being dropped. A token whose caps
 * column says `read,wrote` should fail loudly at the request that uses it, not
 * quietly become read-only some months after somebody typed it - the same
 * reasoning `resolveView` uses for an unknown view name.
 */
export function parseCaps(raw: string | null | undefined): ReadonlySet<Capability> | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const p of parts) {
    if (!isCapability(p)) {
      throw new Error(`unknown capability ${JSON.stringify(p)}. known: ${CAPABILITIES.join(", ")}`);
    }
  }
  return new Set(parts as Capability[]);
}

/** Back to the column, in the canonical order so two equal sets store identically. */
export function serialiseCaps(caps: ReadonlySet<Capability> | undefined): string | null {
  if (!caps) return null;
  const kept = CAPABILITIES.filter((c) => caps.has(c));
  return kept.length ? kept.join(",") : null;
}

/**
 * What an audience's token may do when its `caps` column is NULL.
 *
 * This is exactly today's behaviour written down: an audience reads, it may
 * spend a model call because answering is the whole point of it being in the
 * room, it captures only if its audience says so, and it never writes.
 *
 * Derived per request rather than materialised at mint time, because audiences
 * are reloaded live - a copy taken when the token was minted would stop
 * tracking the config the owner is editing.
 */
export function audienceCaps(capture: boolean): ReadonlySet<Capability> {
  const caps: Capability[] = ["read", "ask"];
  if (capture) caps.push("capture");
  return new Set(caps);
}

/**
 * The columns as they come off the token row, before any config is consulted.
 * `caps` is the raw string; the views are names.
 */
export type GrantColumns = {
  caps?: string | null;
  readView?: string | null;
  writeView?: string | null;
};

/**
 * Fold the token's columns together with its audience's defaults.
 *
 * Explicit columns always win. An audience supplies defaults for whatever the
 * token did not say, and a token with neither is the owner's own device: every
 * capability, no path constraint, which is what every token minted before any
 * of this existed has to keep meaning.
 */
export function resolveGrant(
  columns: GrantColumns,
  audience: { view?: View; capture: boolean } | undefined,
  resolve: (name: string) => View | undefined,
): Grant {
  const explicit = parseCaps(columns.caps);
  const caps = explicit ?? (audience ? audienceCaps(audience.capture) : OWNER_CAPS);

  const read = columns.readView ? resolve(columns.readView) : audience?.view;
  // A write view is only ever explicit. Inheriting the read view would quietly
  // grant write everywhere the caller can read, which is the larger of the two
  // permissions and not the one that was asked for.
  const write = columns.writeView ? resolve(columns.writeView) : undefined;

  return { caps, ...(read ? { read } : {}), ...(write ? { write } : {}) };
}

/** Whether a grant carries a capability. Reads better than the Set at call sites. */
export function may(grant: Grant, cap: Capability): boolean {
  return grant.caps.has(cap);
}

/**
 * How a refused write should describe itself.
 *
 * Deliberately the opposite of how a refused *read* behaves. `mcp.ts` collapses
 * absent, hidden and malformed into one flat message, because telling a caller
 * which of those it hit tells it which notes exist outside its view. A write
 * rejection discloses nothing about the vault - it describes the caller's own
 * permission - so it may and should say what would have been allowed.
 */
export function writeRefusal(grant: Grant, relPath: string): string {
  if (!may(grant, "write")) return "this token may read the notes but not write to them";
  const allowed = grant.write?.include?.join(", ");
  return allowed
    ? `this token may not write to ${relPath}. it may write to: ${allowed}`
    : `this token may not write to ${relPath}`;
}
