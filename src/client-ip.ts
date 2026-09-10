/**
 * Who a request actually came from, once something is in front of the server.
 *
 * Every per-caller limit in this codebase keys on an address: the failed-
 * credential throttle and the pairing-code lockout both do. Put a reverse proxy
 * in front and `server.requestIP` becomes the proxy's own address for every
 * request that has ever arrived, so those limits stop being per-caller and
 * become per-server.
 *
 * That is not a degradation, it is an inversion. Ten wrong tokens from anybody
 * would lock out *everybody*, which turns a defence against guessing into a
 * one-line denial of service against the owner. So the throttle landing before
 * the public hostname is only half the job; this is the other half, and it has
 * to land in the same change or the first one is worse than nothing.
 *
 * ## Why this is opt-in
 *
 * `X-Forwarded-For` is a request header, which means a client can send one. If
 * this trusted it unconditionally, any caller could spoof a different address
 * per request and never be throttled at all - strictly worse than keying on the
 * socket. So it is consulted only when the operator has said there is a proxy,
 * and `tama expose --public` is what says so.
 *
 * ## Why the rightmost entry
 *
 * The header is a list, appended to hop by hop: `client, proxy1, proxy2`. A
 * client that forges `X-Forwarded-For: 1.2.3.4` gets `1.2.3.4, <real client>`
 * once the trusted proxy appends what it actually saw. The leftmost entry is
 * therefore attacker-controlled and the rightmost is the only one written by
 * something we trust - so with exactly one trusted hop, the last entry is the
 * true peer and everything to its left is decoration.
 *
 * One hop is the only shape supported on purpose. Counting further left means
 * knowing how many proxies there are, and a wrong count is silently exploitable
 * in exactly the way this function exists to prevent.
 */

/** What a caller is called when nothing can be determined. Shared by every limiter. */
export const UNKNOWN_CALLER = "unknown";

export function clientIp(
  req: Request,
  socketAddress: string | undefined,
  trustProxy: boolean,
): string {
  if (!trustProxy) return socketAddress || UNKNOWN_CALLER;

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    // Rightmost non-empty entry: what the trusted proxy appended.
    const hops = forwarded.split(",").map((h) => h.trim()).filter(Boolean);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }

  // Configured for a proxy and the header is absent, so this request did not
  // come through it. Falling back to the socket keeps a direct caller - a probe
  // on the loopback publish, say - counted rather than pooled under "unknown"
  // with everyone else.
  return socketAddress || UNKNOWN_CALLER;
}
