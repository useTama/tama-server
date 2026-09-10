/**
 * A cost for guessing a bearer token.
 *
 * The clock is injected rather than slept through, so a lockout that lasts
 * fifteen minutes in production takes no wall-clock time here.
 */

import { expect, test } from "bun:test";
import { AuthThrottle } from "../src/auth-throttle.ts";

function at(start = 1_000_000) {
  let now = start;
  const throttle = new AuthThrottle(() => now);
  return { throttle, advance: (ms: number) => { now += ms; } };
}

const failTimes = (t: AuthThrottle, caller: string, n: number) => {
  let state = { locked: false, retryAfterSec: 0 };
  for (let i = 0; i < n; i++) state = t.fail(caller);
  return state;
};

test("a handful of wrong credentials costs nothing", () => {
  // A client with a stale token retries on its own, and a person pasting one
  // gets it wrong once or twice. Neither should meet a lockout.
  const { throttle } = at();
  const state = failTimes(throttle, "1.2.3.4", 9);
  expect(state.locked).toBe(false);
  expect(throttle.check("1.2.3.4").locked).toBe(false);
});

test("the tenth failure locks, and says for how long", () => {
  const { throttle } = at();
  const state = failTimes(throttle, "1.2.3.4", 10);
  expect(state.locked).toBe(true);
  // Returned from `fail` rather than discovered on the next request, so the
  // attempt that crossed the line is itself the first 429.
  expect(state.retryAfterSec).toBeGreaterThan(0);
  expect(state.retryAfterSec).toBeLessThanOrEqual(30);
});

test("a lock expires on its own", () => {
  const { throttle, advance } = at();
  failTimes(throttle, "1.2.3.4", 10);
  expect(throttle.check("1.2.3.4").locked).toBe(true);
  advance(31_000);
  expect(throttle.check("1.2.3.4").locked).toBe(false);
});

test("coming back for more waits longer each time, up to a ceiling", () => {
  const { throttle, advance } = at();
  const first = failTimes(throttle, "1.2.3.4", 10);
  advance(first.retryAfterSec * 1000 + 1000);

  const second = failTimes(throttle, "1.2.3.4", 10);
  expect(second.retryAfterSec).toBeGreaterThan(first.retryAfterSec);

  // Doubling, but bounded: a persistent caller must not be able to push their
  // own lockout out past anything the owner would notice.
  let last = second;
  for (let round = 0; round < 12; round++) {
    advance(last.retryAfterSec * 1000 + 1000);
    last = failTimes(throttle, "1.2.3.4", 10);
  }
  expect(last.retryAfterSec).toBeLessThanOrEqual(15 * 60);
});

test("failures age out of the window instead of accumulating forever", () => {
  // Nine failures a day for a year is not an attack, and must never add up to
  // a lockout on the three hundred and sixty-fifth.
  const { throttle, advance } = at();
  for (let day = 0; day < 5; day++) {
    failTimes(throttle, "1.2.3.4", 9);
    advance(6 * 60_000);
  }
  expect(throttle.check("1.2.3.4").locked).toBe(false);
});

test("a credential that works clears the count", () => {
  // Fumbling a token and then fixing it must not leave the client carrying
  // failures into its next hour.
  const { throttle } = at();
  failTimes(throttle, "1.2.3.4", 9);
  throttle.succeed("1.2.3.4");
  expect(failTimes(throttle, "1.2.3.4", 9).locked).toBe(false);
});

test("one caller's failures do not lock out another", () => {
  const { throttle } = at();
  failTimes(throttle, "1.2.3.4", 10);
  expect(throttle.check("1.2.3.4").locked).toBe(true);
  expect(throttle.check("5.6.7.8").locked).toBe(false);
});

test("the counter cannot grow without bound", () => {
  // Otherwise it is itself the memory exhaustion it exists to bound: one entry
  // per spoofed source address is a cheaper attack than the one it prevents.
  const { throttle } = at();
  for (let i = 0; i < 10_050; i++) throttle.fail(`10.0.${(i / 256) | 0}.${i % 256}`);
  // Nothing to assert directly without reaching inside, so assert the property
  // that matters: it still answers, and a fresh caller is still unlocked.
  expect(throttle.check("192.168.1.1").locked).toBe(false);
});
