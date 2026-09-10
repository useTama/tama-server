/**
 * Who a request came from, once a proxy terminates TLS in front.
 *
 * The failure these exist to prevent has two directions, and both are worse
 * than doing nothing:
 *
 * - Trust the header always, and any caller sets a fresh address per request
 *   and is never throttled.
 * - Trust the socket always, and behind a proxy every request shares one
 *   address, so ten wrong tokens from anybody locks out everybody.
 */

import { expect, test } from "bun:test";
import { clientIp, UNKNOWN_CALLER } from "../src/client-ip.ts";

const withHeader = (value?: string) =>
  new Request("http://tama.local/ask", value ? { headers: { "x-forwarded-for": value } } : {});

test("without a proxy configured, the header is ignored entirely", () => {
  // The spoofing case. A caller who sets this header must not be able to pick
  // their own throttle bucket.
  const req = withHeader("1.2.3.4");
  expect(clientIp(req, "203.0.113.9", false)).toBe("203.0.113.9");
});

test("with a proxy configured, the rightmost entry wins", () => {
  // `client, proxy1` - the last entry is what the trusted hop appended, and it
  // is the only one not under the caller's control.
  const req = withHeader("198.51.100.7");
  expect(clientIp(req, "172.18.0.2", true)).toBe("198.51.100.7");
});

test("a forged header cannot displace what the proxy appended", () => {
  // The attack: send X-Forwarded-For: 1.2.3.4, and Caddy appends the real peer
  // to the right of it. Taking the leftmost entry would hand the attacker a
  // fresh bucket per request; taking the rightmost gives their real address.
  const req = withHeader("1.2.3.4, 198.51.100.7");
  expect(clientIp(req, "172.18.0.2", true)).toBe("198.51.100.7");
});

test("whitespace and empty hops do not produce an empty caller", () => {
  // An empty caller would pool with everything else that failed to resolve,
  // which is the shared-bucket failure by another route.
  expect(clientIp(withHeader(" 1.2.3.4 ,  198.51.100.7 "), "172.18.0.2", true)).toBe("198.51.100.7");
  expect(clientIp(withHeader("198.51.100.7, "), "172.18.0.2", true)).toBe("198.51.100.7");
  expect(clientIp(withHeader(" , "), "172.18.0.2", true)).toBe("172.18.0.2");
  expect(clientIp(withHeader(""), "172.18.0.2", true)).toBe("172.18.0.2");
});

test("configured for a proxy but reached directly falls back to the socket", () => {
  // The loopback publish is still there when Caddy is in front, so a local
  // probe arrives with no header. It should stay its own caller rather than
  // joining a shared "unknown" bucket with everyone else.
  expect(clientIp(withHeader(undefined), "127.0.0.1", true)).toBe("127.0.0.1");
});

test("nothing to go on is named rather than blank", () => {
  expect(clientIp(withHeader(undefined), undefined, true)).toBe(UNKNOWN_CALLER);
  expect(clientIp(withHeader(undefined), undefined, false)).toBe(UNKNOWN_CALLER);
  expect(clientIp(withHeader(undefined), "", false)).toBe(UNKNOWN_CALLER);
});
