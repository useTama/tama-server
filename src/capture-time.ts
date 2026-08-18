/**
 * When did the user actually speak?
 *
 * The server's own clock is the wrong answer. A capture held in a client's
 * offline queue and drained hours later would be filed on the wrong day.
 *
 * But a device-first product cannot simply demand an absolute timestamp either.
 * The ESP32-S3 has no battery-backed RTC: on boot its clock is meaningless until
 * SNTP syncs over Wi-Fi, and the moment a capture most needs queueing is exactly
 * the moment Wi-Fi is down. A device can be certain how long ago something
 * happened while having no idea what time it is.
 *
 * So two ways in, and every client uses whichever it can actually honour:
 *
 *   capturedAt    absolute ISO-8601. Phones, laptops, Shortcuts.
 *   capturedAgeMs milliseconds since the recording, from a monotonic clock.
 *                 Devices with no RTC. The server does the arithmetic.
 */

export const MAX_FUTURE_MS = 2 * 60 * 1000;        // clock skew tolerance
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // a month of queued backlog

export type TimeInput = {
  capturedAt?: string | null;
  capturedAgeMs?: number | string | null;
};

export type TimeResult = {
  at: Date;
  /** How the timestamp was arrived at. Goes in the journal so it is auditable. */
  basis: "client-absolute" | "client-age" | "server-clock";
  /** Set when a client value was rejected, so the client can be told it is wrong. */
  warning?: string;
};

export function resolveCaptureTime(input: TimeInput, now = new Date()): TimeResult {
  const nowMs = now.getTime();

  if (input.capturedAgeMs !== undefined && input.capturedAgeMs !== null && input.capturedAgeMs !== "") {
    const age = Number(input.capturedAgeMs);
    if (!Number.isFinite(age) || age < 0) {
      return { at: now, basis: "server-clock", warning: "capturedAgeMs was not a non-negative number" };
    }
    if (age > MAX_AGE_MS) {
      return { at: now, basis: "server-clock", warning: "capturedAgeMs older than 30 days" };
    }
    return { at: new Date(nowMs - age), basis: "client-age" };
  }

  if (input.capturedAt) {
    const t = new Date(input.capturedAt);
    if (Number.isNaN(t.getTime())) {
      return { at: now, basis: "server-clock", warning: "capturedAt was not a valid date" };
    }
    const delta = t.getTime() - nowMs;
    if (delta > MAX_FUTURE_MS) {
      return { at: now, basis: "server-clock", warning: "capturedAt is in the future" };
    }
    if (-delta > MAX_AGE_MS) {
      return { at: now, basis: "server-clock", warning: "capturedAt is older than 30 days" };
    }
    return { at: t, basis: "client-absolute" };
  }

  // No client opinion. Only correct for something posting in real time, like curl.
  return { at: now, basis: "server-clock" };
}
