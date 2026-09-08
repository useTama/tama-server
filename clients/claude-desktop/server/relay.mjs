/**
 * One JSON-RPC message in, at most one out. The whole bundle, minus the pipe.
 *
 * Kept apart from `index.mjs` because everything worth testing is here and
 * nothing here touches stdin, stdout or a clock. `index.mjs` is the wiring.
 */

/** JSON-RPC's own code for "the server broke", which is what a dead pipe is. */
const INTERNAL_ERROR = -32603;

/** Cap on relayed text, so a proxy's HTML error page is not a wall in a chat. */
const MAX_DETAIL = 300;

/**
 * What tama said about a failure, kept rather than replaced by the status.
 *
 * The same lesson as `http-error.mjs` in the WhatsApp client, learned the same
 * way: a bare "HTTP 500" reaching a person who could have fixed the cause is
 * worse than unhelpful. Here it matters more, because the person installing
 * this has a URL and a token to get wrong and no log to read.
 */
function detailFrom(status, text) {
  const body = typeof text === "string" ? text.trim() : "";
  let message = "";
  if (body) {
    try {
      const parsed = JSON.parse(body);
      message = typeof parsed?.error === "string" ? parsed.error.trim() : body;
    } catch {
      // Not JSON. A reverse proxy's HTML page lands here and its text is
      // still more use than the number alone.
      message = body;
    }
  }
  message = message.replace(/\s+/g, " ").trim();
  if (message.length > MAX_DETAIL) message = `${message.slice(0, MAX_DETAIL)}...`;

  // The two failures an install actually produces, named as themselves. A
  // self-hoster reading "HTTP 401" has to go and look that up; a self-hoster
  // reading this does not.
  if (status === 401) {
    return "Tama refused the device token. Mint a fresh one with `tama token claude-desktop` and paste it into this extension's settings.";
  }
  if (status === 403) {
    return `Tama accepted the token but refused the request${message ? `: ${message}` : ""}.`;
  }
  return message || `Tama answered HTTP ${status} and said nothing.`;
}

/** Why the server could not be reached at all, in words rather than a code. */
function unreachable(url, cause) {
  return (
    `Could not reach Tama at ${url}. ` +
    `Check the server address in this extension's settings, and that the server is reachable ` +
    `from this machine - a tailnet address needs Tailscale running here, and 127.0.0.1 only ` +
    `works if Tama runs on this same machine. (${cause})`
  );
}

/**
 * Relay one parsed message to tama's `/mcp` and return what to write back, or
 * `null` when nothing should be written.
 *
 * `null` is not an edge case, it is half the protocol: a notification has no
 * `id`, takes no response, and answering one is itself a protocol error. tama
 * answers those 202 with an empty body, so "no body" and "no reply" line up.
 */
export async function relay(message, { url, token, fetchImpl = fetch, timeoutMs = 300_000 }) {
  const id = message?.id;
  const isNotification = id === undefined || id === null;
  const endpoint = `${url.replace(/\/+$/, "")}/mcp`;

  let res;
  try {
    res = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isNotification) return null;
    const cause = error instanceof Error ? error.message : String(error);
    return { jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: unreachable(url, cause) } };
  }

  // 202 and 204 are tama acknowledging a notification. Nothing to forward, and
  // forwarding an empty line would be a parse error at the other end.
  if (res.status === 202 || res.status === 204) return null;

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: detailFrom(res.status, text) } };
  }

  try {
    return JSON.parse(text);
  } catch {
    if (isNotification) return null;
    // A 200 that is not JSON means something between here and tama answered
    // instead of it - a captive portal, a proxy, the wrong port entirely.
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: INTERNAL_ERROR,
        message: `Tama's reply was not JSON, so something other than Tama answered ${endpoint}. Check the server address.`,
      },
    };
  }
}
