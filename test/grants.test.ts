/**
 * What a token may do, and where.
 *
 * The behaviour these pin down is mostly *absence*: a token with none of the
 * new columns has to keep meaning exactly what it meant before they existed,
 * because every token minted so far is that token. Half of this file is
 * therefore about NULL.
 *
 * The other half is the shape that was unexpressible while write access meant
 * "has no audience" - reads one slice, writes into a corner of it - which is
 * the case #38 exists for.
 */

import { expect, test } from "bun:test";
import {
  audienceCaps,
  CAPABILITIES,
  may,
  OWNER_CAPS,
  parseCaps,
  resolveGrant,
  serialiseCaps,
  writeRefusal,
} from "../src/grants.ts";
import type { View } from "../src/views.ts";

const views: Record<string, View> = {
  work: { include: ["Work/**"] },
  "work-logs": { include: ["Work/**/sessions.md"] },
};
const resolve = (name: string): View | undefined => {
  const v = views[name];
  if (!v) throw new Error(`unknown view ${JSON.stringify(name)}`);
  return v;
};

test("a token with no columns and no audience is the owner's own device", () => {
  // The compatibility case, and the one that must never quietly narrow: every
  // token minted before capabilities existed arrives here.
  const grant = resolveGrant({}, undefined, resolve);
  for (const cap of CAPABILITIES) expect(may(grant, cap)).toBe(true);
  expect(grant.read).toBeUndefined();
  expect(grant.write).toBeUndefined();
});

test("an audience token keeps exactly the access it had before capabilities", () => {
  // Reads, may spend a model call because answering is why it is in the room,
  // and never writes. That was `mayWrite: !device.audience`; it is now a
  // derived default, and the point of this test is that the two agree.
  const grant = resolveGrant({}, { view: views.work, capture: false }, resolve);
  expect(may(grant, "read")).toBe(true);
  expect(may(grant, "ask")).toBe(true);
  expect(may(grant, "write")).toBe(false);
  expect(may(grant, "capture")).toBe(false);
  expect(grant.read).toEqual({ include: ["Work/**"] });
});

test("an audience that captures gets the capability, and one that does not cannot", () => {
  // `audience.capture` is documented as "never captures into the vault" and
  // until now only the WhatsApp client honoured it.
  expect(may(resolveGrant({}, { capture: true }, resolve), "capture")).toBe(true);
  expect(may(resolveGrant({}, { capture: false }, resolve), "capture")).toBe(false);
});

test("explicit caps beat the audience's defaults", () => {
  const grant = resolveGrant({ caps: "read" }, { view: views.work, capture: true }, resolve);
  expect(may(grant, "read")).toBe(true);
  expect(may(grant, "ask")).toBe(false);
  expect(may(grant, "capture")).toBe(false);
});

test("the shape that could not be expressed: reads a slice, writes into a corner of it", () => {
  const grant = resolveGrant(
    { caps: "read,write", readView: "work", writeView: "work-logs" },
    undefined,
    resolve,
  );
  expect(may(grant, "read")).toBe(true);
  expect(may(grant, "write")).toBe(true);
  // Not billable. An agent that searches a hundred times a session is not
  // thereby allowed to spend a hundred completions.
  expect(may(grant, "ask")).toBe(false);
  expect(grant.read).toEqual({ include: ["Work/**"] });
  expect(grant.write).toEqual({ include: ["Work/**/sessions.md"] });
});

test("a write view is never inherited from the read view", () => {
  // Inheriting would silently grant write everywhere the caller can read,
  // which is the larger of the two permissions and not the one asked for.
  const grant = resolveGrant({ caps: "read,write", readView: "work" }, undefined, resolve);
  expect(grant.read).toEqual({ include: ["Work/**"] });
  expect(grant.write).toBeUndefined();
});

test("caps parse: NULL and empty are unrestricted, a typo is not silently dropped", () => {
  expect(parseCaps(null)).toBeUndefined();
  expect(parseCaps(undefined)).toBeUndefined();
  expect(parseCaps("")).toBeUndefined();
  expect(parseCaps("  ,  ")).toBeUndefined();
  expect([...parseCaps("read, write")!]).toEqual(["read", "write"]);

  // The `resolveView` rule applied to capabilities: a name nobody recognises
  // fails loudly, because the alternative is a token that quietly became
  // read-only some months after somebody mistyped it.
  expect(() => parseCaps("read,wrote")).toThrow(/unknown capability/);
});

test("caps serialise in a canonical order, so two equal sets store identically", () => {
  expect(serialiseCaps(new Set(["write", "read"]))).toBe("read,write");
  expect(serialiseCaps(new Set(["ask", "capture"]))).toBe("capture,ask");
  expect(serialiseCaps(undefined)).toBeNull();
  expect(serialiseCaps(new Set())).toBeNull();
  expect(serialiseCaps(OWNER_CAPS)).toBe(CAPABILITIES.join(","));
});

test("caps survive a round trip through the column", () => {
  const caps = audienceCaps(true);
  expect(parseCaps(serialiseCaps(caps))).toEqual(caps);
});

test("a view name that has left the config throws rather than widening access", () => {
  // Fail closed. A stale token must not inherit more than it had, which is the
  // same rule the audience lookup applies.
  expect(() => resolveGrant({ readView: "gone" }, undefined, resolve)).toThrow(/unknown view/);
});

test("a refused write says what would have been allowed; a refused read never does", () => {
  const noWrite = resolveGrant({ caps: "read" }, undefined, resolve);
  expect(writeRefusal(noWrite, "Work/a.md")).toMatch(/may read the notes but not write/);

  const scoped = resolveGrant({ caps: "read,write", writeView: "work-logs" }, undefined, resolve);
  // Naming the allowed prefix discloses nothing about the vault - it describes
  // the caller's own permission - and a model told where it may write retries
  // correctly instead of giving up.
  expect(writeRefusal(scoped, "Personal/diary.md")).toContain("Work/**/sessions.md");

  const anywhere = resolveGrant({ caps: "read,write" }, undefined, resolve);
  expect(writeRefusal(anywhere, "Work/a.md")).not.toContain("it may write to:");
});
