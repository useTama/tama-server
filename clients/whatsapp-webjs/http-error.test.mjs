import { expect, test } from "bun:test";
import { errorDetail } from "./http-error.mjs";

test("relays the cause tama put in the body", async () => {
  // The real failure this exists for: doCapture returns the message from
  // whatever threw, and the retry loop used to replace the whole response
  // with a bare "HTTP 500".
  const res = Response.json({ error: "ffmpeg is not installed" }, { status: 500 });
  expect(await errorDetail(res)).toBe(": ffmpeg is not installed");
});

test("says nothing extra when the body is empty", async () => {
  expect(await errorDetail(new Response("", { status: 500 }))).toBe("");
  expect(await errorDetail(new Response("   \n ", { status: 503 }))).toBe("");
});

test("keeps a non-JSON body, because a proxy error page still says something", async () => {
  const res = new Response("<html><body>502 Bad Gateway</body></html>", { status: 500 });
  expect(await errorDetail(res)).toContain("502 Bad Gateway");
});

test("keeps JSON that is not tama's shape rather than dropping it", async () => {
  const res = Response.json({ message: "upstream refused" }, { status: 500 });
  expect(await errorDetail(res)).toContain("upstream refused");
});

test("collapses newlines, because a reply is a chat bubble", async () => {
  const res = Response.json({ error: "spawn ffmpeg ENOENT\n  at doCapture\n  at handle" }, { status: 500 });
  expect(await errorDetail(res)).toBe(": spawn ffmpeg ENOENT at doCapture at handle");
});

test("truncates, so a stack trace does not become the whole message", async () => {
  const res = Response.json({ error: "x".repeat(1000) }, { status: 500 });
  const detail = await errorDetail(res);
  expect(detail.endsWith("...")).toBe(true);
  expect(detail.length).toBeLessThan(320);
});

test("an unreadable body cannot turn a reportable failure into an unreportable one", async () => {
  // A body already consumed elsewhere, which is the shape this hits in
  // production if the retry loop is ever reordered.
  const consumed = Response.json({ error: "whisper unreachable" }, { status: 500 });
  await consumed.text();
  expect(await errorDetail(consumed)).toBe("");
  // And an object that is not a Response at all.
  expect(await errorDetail({ text: () => { throw new Error("nope"); } })).toBe("");
});
