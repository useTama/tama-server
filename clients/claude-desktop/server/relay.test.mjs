import { expect, test } from "bun:test";
import { relay } from "./relay.mjs";

const OPTS = { url: "http://tama.local:8080", token: "tok" };

/** A fetch that records what it was asked and answers what the test wants. */
function fakeFetch(answer) {
  const calls = [];
  const impl = async (endpoint, init) => {
    calls.push({ endpoint, init });
    if (typeof answer === "function") return answer();
    return answer;
  };
  return { impl, calls };
}

const ok = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a request is forwarded to /mcp with the token, and the reply comes back whole", async () => {
  const { impl, calls } = fakeFetch(ok({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  const reply = await relay({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...OPTS, fetchImpl: impl });

  expect(calls[0].endpoint).toBe("http://tama.local:8080/mcp");
  expect(calls[0].init.headers.authorization).toBe("Bearer tok");
  expect(reply).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
});

test("a trailing slash on the configured address does not become a double slash", async () => {
  // Someone pasting a URL out of a browser brings the slash with them, and
  // "//mcp" is a 404 that reads like the extension being broken.
  const { impl, calls } = fakeFetch(ok({ jsonrpc: "2.0", id: 1, result: {} }));
  await relay({ jsonrpc: "2.0", id: 1, method: "ping" }, { url: "http://tama.local:8080/", token: "tok", fetchImpl: impl });
  expect(calls[0].endpoint).toBe("http://tama.local:8080/mcp");
});

test("a notification is forwarded and answered with nothing", async () => {
  // Half the protocol. `notifications/initialized` has no id, tama answers 202
  // with no body, and writing a reply to it is itself a protocol error.
  const { impl, calls } = fakeFetch(new Response(null, { status: 202 }));
  const reply = await relay({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...OPTS, fetchImpl: impl });

  expect(calls).toHaveLength(1);
  expect(reply).toBeNull();
});

test("a refused token says which token and how to replace it", async () => {
  // The two things an install gets wrong are the address and the token. Both
  // have to name themselves: the person reading this has no server log.
  const { impl } = fakeFetch(ok({ error: "unknown device token" }, 401));
  const reply = await relay({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...OPTS, fetchImpl: impl });

  expect(reply.error.message).toContain("refused the device token");
  expect(reply.error.message).toContain("tama-server token claude-desktop");
});

test("an unreachable server names the address and why it might not resolve", async () => {
  const { impl } = fakeFetch(() => { throw new Error("ConnectionRefused"); });
  const reply = await relay({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { ...OPTS, fetchImpl: impl });

  expect(reply.error.message).toContain("http://tama.local:8080");
  expect(reply.error.message).toContain("ConnectionRefused");
  // The two reachability traps worth naming before someone files a bug.
  expect(reply.error.message).toContain("Tailscale");
  expect(reply.error.message).toContain("127.0.0.1");
});

test("tama's own explanation of a failure survives the trip", async () => {
  const { impl } = fakeFetch(ok({ error: "token names audience \"guest\", which is not in the config" }, 403));
  const reply = await relay({ jsonrpc: "2.0", id: 4, method: "tools/call" }, { ...OPTS, fetchImpl: impl });
  expect(reply.error.message).toContain("which is not in the config");
});

test("something other than tama answering is reported as that, not as a tama error", async () => {
  // A captive portal or the wrong port returns 200 and HTML. Parsing that as a
  // protocol reply is how a wrong address turns into an unreadable crash.
  const { impl } = fakeFetch(new Response("<html>Sign in to the network</html>", { status: 200 }));
  const reply = await relay({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { ...OPTS, fetchImpl: impl });

  expect(reply.error.message).toContain("not JSON");
  expect(reply.error.message).toContain("Check the server address");
});

test("a failed notification stays silent rather than inventing an id", async () => {
  // A reply carrying id null is a message the client never asked for, and some
  // clients treat an unmatched id as fatal.
  const { impl } = fakeFetch(() => { throw new Error("ConnectionRefused"); });
  const reply = await relay({ jsonrpc: "2.0", method: "notifications/cancelled" }, { ...OPTS, fetchImpl: impl });
  expect(reply).toBeNull();
});

test("an empty error body still produces a sentence", async () => {
  const { impl } = fakeFetch(new Response("", { status: 500 }));
  const reply = await relay({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { ...OPTS, fetchImpl: impl });
  expect(reply.error.message).toContain("HTTP 500");
});
