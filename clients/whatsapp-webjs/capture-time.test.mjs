import { expect, test } from "bun:test";
import { capturedAtHeader } from "./capture-time.mjs";

test("a WhatsApp timestamp becomes an ISO instant", () => {
  // whatsapp-web.js reports seconds, not milliseconds.
  expect(capturedAtHeader({ timestamp: 1757800000 })).toBe("2025-09-13T21:46:40.000Z");
  expect(capturedAtHeader({ timestamp: "1757800000" })).toBe("2025-09-13T21:46:40.000Z");
});

test("a timestamp that would throw is simply absent", () => {
  // This is the whole point of the module. Every one of these used to reach
  // toISOString() and take the capture down with a RangeError about the clock.
  for (const message of [{}, { timestamp: undefined }, { timestamp: null }, { timestamp: NaN }, { timestamp: "soon" }, null, undefined]) {
    expect(capturedAtHeader(message)).toBeUndefined();
  }
});

test("a zero or negative timestamp is absent rather than 1970", () => {
  // Filing a note at the epoch is worse than letting the server use its own
  // clock: it is wrong, and it looks deliberate.
  expect(capturedAtHeader({ timestamp: 0 })).toBeUndefined();
  expect(capturedAtHeader({ timestamp: -5 })).toBeUndefined();
});
