/**
 * The client version contract, which was advertised and never enforced.
 *
 * `/health` has returned `minClient` since the beginning, and the constant's
 * own comment claimed that "clients older than this are refused" - while no
 * code anywhere compared anything (#8). The number was documentation with the
 * grammar of a guarantee.
 *
 * ## Why absent is allowed
 *
 * A capture with no `x-tama-client` header is accepted. That is the whole
 * safety property of this file: every deployed iOS shortcut, every bridge
 * running an older image, and every `curl` in somebody's notes predates the
 * header, and a server that refused them all on upgrade would break the one
 * path that is supposed to work with no account and no key.
 *
 * So this refuses only a client that says, in its own words, that it is too
 * old. Silence is not a claim.
 *
 * ## Why not a semver package
 *
 * Three integers compared in order is fifteen lines, and the alternative is a
 * dependency in a project whose whole llm layer talks to providers over plain
 * fetch. What matters is that it is not a STRING compare: "0.10.0" < "0.9.0"
 * lexicographically, which would refuse a newer client the first time a minor
 * version reached double digits.
 */

/** Clients that say they are older than this are refused on the write path. */
export const MIN_CLIENT = "0.1.0";

export type ClientVersion = {
  /** The client's own name, when it gave one. For the log, not for policy. */
  name?: string;
  version: [number, number, number];
};

/**
 * `tama-ios/0.2.1`, or a bare `0.2.1`.
 *
 * Returns null for anything else, including absent - and null means "made no
 * claim", which is accepted. A malformed header is deliberately treated as
 * silence rather than as a refusal: a client that garbles its own version
 * string is a bug worth a log line, not a reason to drop somebody's voice
 * note on the floor.
 */
export function parseClientVersion(header: string | null | undefined): ClientVersion | null {
  const raw = header?.trim();
  if (!raw) return null;

  const slash = raw.lastIndexOf("/");
  const name = slash > 0 ? raw.slice(0, slash).trim() : undefined;
  const versionPart = slash > 0 ? raw.slice(slash + 1).trim() : raw;

  const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(versionPart);
  if (!m) return null;

  return {
    ...(name ? { name } : {}),
    version: [Number(m[1]), Number(m[2]), Number(m[3])],
  };
}

/** Numeric, field by field, so 0.10.0 is newer than 0.9.0. */
export function belowMinimum(given: [number, number, number], minimum = MIN_CLIENT): boolean {
  const min = parseClientVersion(minimum)?.version;
  // An unparseable minimum would otherwise refuse everything. A bad constant
  // in this file must not become an outage on the capture path.
  if (!min) return false;

  for (let i = 0; i < 3; i++) {
    const a = given[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a < b;
  }
  return false;
}

/** How a client is named in a log line and in the refusal it gets back. */
export function describeClient(client: ClientVersion): string {
  const v = client.version.join(".");
  return client.name ? `${client.name} ${v}` : v;
}
