/**
 * Named subsets of the vault.
 *
 * A view is what an audience is allowed to see. It exists as a name rather than
 * as a list of globs at each call site because the same subset is wanted by
 * three unrelated things - a scoped token, an audience, a channel digest - and
 * three copies of a path filter drift apart. When they drift, a digest quotes a
 * note the chat it posts to could not have retrieved.
 *
 * The filter is applied while walking the vault, never after scoring. Filtering
 * afterwards costs a caller their chunk budget on notes they cannot see, so a
 * narrowed audience silently gets worse answers instead of a smaller set of the
 * right ones.
 */

/** Absent lists mean "no constraint", which is why both are optional. */
export type View = { include?: string[]; exclude?: string[] };

/**
 * The two views nobody should have to write, and nobody may redefine.
 *
 * "Can this group see my notes at all" is the first question anyone asks, and
 * making its answer depend on getting a glob right is how that answer ends up
 * wrong. `none` is also the safe default for a new audience: a mistake means an
 * audience that knows nothing, not one that knows everything.
 */
export const BUILTIN_VIEWS: Record<string, View> = {
  everything: {},
  none: { include: [] },
};

/**
 * Glob to regex, for the small dialect a path filter needs.
 *
 * `**` crosses separators, `*` and `?` do not, and everything else is literal.
 * Deliberately not a full glob implementation: brace expansion and character
 * classes would add expressiveness to a language whose problem is that it is
 * already too easy to get wrong.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // A trailing or separator-adjacent `**` should also match zero
        // segments, so `Projects/**` covers `Projects` itself.
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

const cache = new Map<string, RegExp>();
function compiled(glob: string): RegExp {
  let re = cache.get(glob);
  if (!re) {
    re = globToRegExp(glob);
    cache.set(glob, re);
  }
  return re;
}

/**
 * Whether a vault-relative path is visible through a view.
 *
 * Exclude wins over include, and an empty include list means nothing rather
 * than everything - `{ include: [] }` is how `none` is expressed, so reading it
 * as "unconstrained" would invert the one view that must never be wrong. An
 * absent include list is the unconstrained case.
 */
export function visible(relPath: string, view: View | undefined): boolean {
  if (!view) return true;
  const path = relPath.replace(/^\/+/, "");
  if (view.exclude?.some((glob) => compiled(glob).test(path))) return false;
  if (view.include === undefined) return true;
  return view.include.some((glob) => compiled(glob).test(path));
}

/**
 * Resolve a view by name, built-ins first so they cannot be shadowed.
 *
 * An unknown name throws rather than falling back. A typo that silently means
 * "everything" is the exact failure this whole mechanism exists to prevent.
 */
export function resolveView(views: Record<string, View> | undefined, name: string | undefined): View | undefined {
  if (name === undefined) return undefined;
  const view = BUILTIN_VIEWS[name] ?? views?.[name];
  if (!view) {
    const known = [...Object.keys(BUILTIN_VIEWS), ...Object.keys(views ?? {})].join(", ");
    throw new Error(`unknown view ${JSON.stringify(name)}. known views: ${known}`);
  }
  return view;
}

/** For the settings preview: what a view actually admits, not what it says. */
export function partitionByView(relPaths: string[], view: View | undefined): { visible: string[]; hidden: string[] } {
  const shown: string[] = [];
  const hidden: string[] = [];
  for (const path of relPaths) (visible(path, view) ? shown : hidden).push(path);
  return { visible: shown, hidden };
}
