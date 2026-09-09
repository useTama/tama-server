import { expect, test } from "bun:test";
import { MIN_CLIENT, belowMinimum, describeClient, parseClientVersion } from "../src/client-version.ts";

test("a client that says nothing is making no claim, and is allowed", () => {
  // The safety property of the whole gate. Every deployed iOS shortcut, every
  // bridge on an older image and every curl in somebody's notes predates the
  // header, and refusing them on upgrade would break the one path that is
  // meant to work with no account and no key.
  for (const header of [null, undefined, "", "   "]) {
    expect(parseClientVersion(header)).toBeNull();
  }
});

test("a garbled version is treated as silence, not as a refusal", () => {
  // A client that cannot format its own version is a bug worth a log line,
  // not a reason to drop somebody's voice note.
  for (const header of ["tama-ios", "0.1", "banana", "v", "tama-ios/", "/0.1.0"]) {
    expect(parseClientVersion(header)).toBeNull();
  }
});

test("both shapes a client might send", () => {
  expect(parseClientVersion("0.2.1")).toEqual({ version: [0, 2, 1] });
  expect(parseClientVersion("v0.2.1")).toEqual({ version: [0, 2, 1] });
  expect(parseClientVersion("tama-ios/0.2.1")).toEqual({ name: "tama-ios", version: [0, 2, 1] });
  expect(parseClientVersion("tama-whatsapp-webjs/1.0.0"))
    .toEqual({ name: "tama-whatsapp-webjs", version: [1, 0, 0] });
  // Trailing build metadata is ignored rather than rejected.
  expect(parseClientVersion("tama-ios/0.2.1-beta.3")).toEqual({ name: "tama-ios", version: [0, 2, 1] });
});

test("the comparison is numeric, not lexicographic", () => {
  // The failure a string compare produces, and the reason this is hand-rolled:
  // "0.10.0" < "0.9.0" as text, so the first client to reach a double-digit
  // minor version would have been refused as ancient.
  expect(belowMinimum([0, 10, 0], "0.9.0")).toBe(false);
  expect(belowMinimum([0, 9, 0], "0.10.0")).toBe(true);
  expect(belowMinimum([1, 0, 0], "0.99.99")).toBe(false);
  expect(belowMinimum([0, 99, 99], "1.0.0")).toBe(true);
});

test("equal is not below", () => {
  expect(belowMinimum([0, 1, 0], "0.1.0")).toBe(false);
  expect(belowMinimum([0, 0, 9], "0.1.0")).toBe(true);
  expect(belowMinimum([0, 1, 1], "0.1.0")).toBe(false);
});

test("nothing is below the current minimum by accident", () => {
  // Guards the constant itself: if MIN_CLIENT is ever bumped past the version
  // the shipped clients send, this is where that shows up.
  expect(belowMinimum(parseClientVersion(MIN_CLIENT)!.version)).toBe(false);
});

test("an unparseable minimum refuses nobody", () => {
  // A bad constant in this file must not become an outage on the capture path.
  expect(belowMinimum([0, 0, 1], "not-a-version")).toBe(false);
  expect(belowMinimum([0, 0, 1], "")).toBe(false);
});

test("a refusal names the client the way its author would recognise it", () => {
  expect(describeClient({ name: "tama-ios", version: [0, 0, 9] })).toBe("tama-ios 0.0.9");
  expect(describeClient({ version: [0, 0, 9] })).toBe("0.0.9");
});
