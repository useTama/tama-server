/**
 * The whole OAuth flow, through the real routes.
 *
 * The unit tests in oauth.test.ts cover the pieces. This walks the exchange a
 * connector actually performs - refused, discover, authorise, consent, exchange,
 * use, refresh, revoke - because every one of those steps is a place the flow
 * can be individually correct and collectively broken.
 */

import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { openDb } from "../src/db.ts";
import { Vault } from "../src/vault.ts";
import { GrepRetriever } from "../src/retrieval.ts";
import { createRoutes, type RouteDeps } from "../src/routes.ts";
import type { Stt } from "../src/stt.ts";
import type { Config } from "../src/config.ts";
import { parseCaps } from "../src/grants.ts";

const ADMIN = "a".repeat(48);
const ISSUER = "https://tama.example.com";
const CALLBACK = "https://claude.ai/api/mcp/auth_callback";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tama-oauth-flow-"));
  await Vault.initialize(join(root, "vault"));
  await mkdir(join(root, "vault/Work"), { recursive: true });
  await writeFile(join(root, "vault/Work/cpa.md"), "the mic gain was clipping on the m4");
  const db = openDb(join(root, "data/tama.db"));

  const config = {
    vault: { path: join(root, "vault"), inbox: "Inbox" },
    dataDir: join(root, "data"),
    stt: { provider: "whisper-cpp" as const, url: "http://127.0.0.1:9" },
    server: {
      port: 0,
      adminToken: ADMIN,
      publicBaseUrl: ISSUER,
      trustProxy: false,
      oauth: { extraRedirects: [], cimdOrigins: ["https://claude.ai"] },
    },
    notify: { provider: "console" as const, ntfy: { url: "", topic: "" }, digestAt: "08:00" },
    safety: { allowUnbackedVault: false, dryRun: false },
  } as unknown as Config;

  const deps: RouteDeps = {
    config,
    db,
    vault: new Vault(config.vault.path, "Inbox", false, false),
    stt: { async transcribe() { return ""; }, async health() { return true; }, endpoint: "fake" } as unknown as Stt,
    retriever: new GrepRetriever(config.vault.path),
    llm: null,
    notifier: { name: "console", async send() {} },
    onWrite: () => {},
  };
  const routes = createRoutes(deps);
  return { routes, db, cleanup: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://tama.example.com${path}`, { headers });
const form = (path: string, body: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(body)) {
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  }
  return new Request(`https://tama.example.com${path}`, { method: "POST", body: fd });
};

test("a connector is refused with somewhere to go", async () => {
  const f = await fixture();
  try {
    // No Authorization header at all: the mandated first step. It must carry
    // the challenge, and it must NOT be counted as a wrong credential - a
    // connector that throttles itself out on step one never connects.
    const res = await f.routes.handle(new Request("https://tama.example.com/mcp", { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("Bearer");
    expect(challenge).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`);

    for (let i = 0; i < 15; i++) {
      const again = await f.routes.handle(new Request("https://tama.example.com/mcp", { method: "POST", body: "{}" }));
      expect(again.status).toBe(401);
    }
  } finally {
    await f.cleanup();
  }
});

test("discovery answers at both well-known paths", async () => {
  const f = await fixture();
  try {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const body = await (await f.routes.handle(get(p))).json() as any;
      expect(body.resource).toBe(`${ISSUER}/mcp`);
      expect(body.authorization_servers).toEqual([ISSUER]);
    }
    const as = await (await f.routes.handle(get("/.well-known/oauth-authorization-server"))).json() as any;
    expect(as.issuer).toBe(ISSUER);
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  } finally {
    await f.cleanup();
  }
});

test("the whole flow: authorise, consent, exchange, use, refresh, revoke", async () => {
  const f = await fixture();
  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    // 1. The owner lands on the consent page.
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "https://claude.ai/oauth/client-metadata",
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "opaque",
      scope: "read write",
      resource: `${ISSUER}/mcp`,
    });
    const page = await f.routes.handle(get(`/oauth/authorize?${q}`));
    expect(page.status).toBe(200);
    const html = await page.text();
    // The form must be submittable: copying the pairing page's form-action
    // 'none' verbatim yields an Allow button that silently does nothing.
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    // Nothing about the vault's contents or structure, because this page is
    // reachable by anyone who can construct a request.
    expect(html).not.toContain("Work/");
    expect(html).toContain("claude.ai");

    const requestId = html.match(/name="request" value="([^"]+)"/)![1]!;

    // 2. A wrong admin token grants nothing.
    const wrong = await f.routes.handle(form("/oauth/authorize", { request: requestId, admin: "nope", decision: "allow", scope: "read" }));
    expect(wrong.status).toBe(401);

    // 3. The owner consents, ticking less than was asked for.
    const allowed = await f.routes.handle(form("/oauth/authorize", { request: requestId, admin: ADMIN, decision: "allow", scope: "read" }));
    expect(allowed.status).toBe(302);
    const to = new URL(allowed.headers.get("location")!);
    expect(to.origin + to.pathname).toBe(CALLBACK);
    expect(to.searchParams.get("state")).toBe("opaque");
    // RFC 9207, advertised in the metadata so it must actually be sent.
    expect(to.searchParams.get("iss")).toBe(ISSUER);
    const code = to.searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 4. A wrong PKCE verifier does not get a token.
    const badPkce = await f.routes.handle(form("/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: "wrong",
    }));
    expect(badPkce.status).toBe(400);
    expect((await badPkce.json() as any).error).toBe("invalid_grant");

    // ...and that consumed the code, so the real verifier is now too late.
    const tooLate = await f.routes.handle(form("/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier,
    }));
    expect(tooLate.status).toBe(400);
  } finally {
    await f.cleanup();
  }
});

test("a granted token reaches MCP with exactly the scopes ticked", async () => {
  const f = await fixture();
  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code", client_id: "https://claude.ai/oauth/client-metadata",
      redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", scope: "read write",
    });
    const html = await (await f.routes.handle(get(`/oauth/authorize?${q}`))).text();
    const requestId = html.match(/name="request" value="([^"]+)"/)![1]!;

    // Ticks read only, though the client asked for read AND write.
    const redirect = await f.routes.handle(form("/oauth/authorize", { request: requestId, admin: ADMIN, decision: "allow", scope: "read" }));
    const code = new URL(redirect.headers.get("location")!).searchParams.get("code")!;

    const tokenRes = await f.routes.handle(form("/oauth/token", {
      grant_type: "authorization_code", code, redirect_uri: CALLBACK, code_verifier: verifier,
    }));
    expect(tokenRes.status).toBe(200);
    const tok = await tokenRes.json() as any;
    expect(tok.token_type).toBe("Bearer");
    expect(tok.scope).toBe("read");
    expect(tok.expires_in).toBeGreaterThan(0);

    const auth = { authorization: `Bearer ${tok.access_token}` };
    const rpc = (method: string, params?: unknown) =>
      new Request("https://tama.example.com/mcp", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });

    // It can read...
    const list = await (await f.routes.handle(rpc("tools/list"))).json() as any;
    const names = list.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["read_note", "search_notes", "today"]);

    // ...and cannot write, because the owner did not tick it. The consent
    // screen and the enforcement have to agree, and this is where that is
    // proven rather than asserted.
    const write = await (await f.routes.handle(rpc("tools/call", { name: "append_note", arguments: { path: "Work/x.md", text: "hi" } }))).json() as any;
    expect(write.result.isError).toBe(true);

    // Refresh rotates both halves.
    const refreshed = await f.routes.handle(form("/oauth/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token }));
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json() as any;
    expect(next.access_token).not.toBe(tok.access_token);
    expect(next.refresh_token).not.toBe(tok.refresh_token);

    // The old refresh token is dead.
    const replay = await f.routes.handle(form("/oauth/token", { grant_type: "refresh_token", refresh_token: tok.refresh_token }));
    expect(replay.status).toBe(400);

    // Revocation kills it, and answers 200 either way so it cannot be used to
    // guess which tokens exist.
    expect((await f.routes.handle(form("/oauth/revoke", { token: next.refresh_token }))).status).toBe(200);
    expect((await f.routes.handle(form("/oauth/revoke", { token: "never-existed" }))).status).toBe(200);
    const dead = await f.routes.handle(rpc("tools/list"));
    expect(dead.status).toBe(401);
  } finally {
    await f.cleanup();
  }
});

test("granting nothing issues nothing, rather than issuing everything", async () => {
  // The inversion this exists to prevent: an empty capability set was written
  // as a NULL-ish `caps` column, NULL means "the owner's own device", and so
  // consenting to nothing minted an unrestricted token over the whole vault -
  // to a client dialled from someone else's servers.
  //
  // Reachable two ways, and this covers the one a client can drive on its own:
  // ask for a scope that carries no capability. `offline_access` is a real
  // scope Claude appends, and it is correctly dropped, which left the granted
  // set empty.
  const f = await fixture();
  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code", client_id: "https://claude.ai/oauth/client-metadata",
      redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", scope: "offline_access",
    });
    const html = await (await f.routes.handle(get(`/oauth/authorize?${q}`))).text();
    const requestId = html.match(/name="request" value="([^"]+)"/)![1]!;

    const redirect = await f.routes.handle(form("/oauth/authorize", {
      request: requestId, admin: ADMIN, decision: "allow", scope: "offline_access",
    }));

    // The consent step refuses rather than issuing a code for nothing, so the
    // dangerous value never reaches the token endpoint at all.
    const location = new URL(redirect.headers.get("location")!);
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("error")).toBe("access_denied");

    // Belt and braces, at the layer underneath: even if a caller found a way to
    // park an empty grant, the column itself is now refused. This is the half
    // that was actually missing - the flow was guarded, the primitive was not,
    // so the next thing to write a caps column would have met the same trap.
    expect(() => parseCaps("")).toThrow(/at least one capability/);
  } finally {
    await f.cleanup();
  }
});

test("a code is never sent anywhere but a known callback", async () => {
  const f = await fixture();
  try {
    const q = new URLSearchParams({
      response_type: "code", client_id: "https://claude.ai/oauth/client-metadata",
      redirect_uri: "https://evil.example.com/cb", code_challenge: "x", code_challenge_method: "S256",
    });
    const res = await f.routes.handle(get(`/oauth/authorize?${q}`));
    // Refused here rather than redirected: sending even an error to an
    // unvalidated redirect is how an authorization server becomes an open
    // redirector.
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect((await res.json() as any).error).toBe("invalid_request");
  } finally {
    await f.cleanup();
  }
});

test("nothing OAuth is mounted without a public hostname", async () => {
  // The accountless local path must not grow a login it never needed, and an
  // issuer is meaningless on loopback.
  const f = await fixture();
  try {
    const local = await fixtureWithoutOAuth();
    try {
      expect((await local.routes.handle(get("/.well-known/oauth-protected-resource"))).status).toBe(401);
    } finally {
      await local.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

async function fixtureWithoutOAuth() {
  const root = await mkdtemp(join(tmpdir(), "tama-nooauth-"));
  await Vault.initialize(join(root, "vault"));
  const db = openDb(join(root, "data/tama.db"));
  const config = {
    vault: { path: join(root, "vault"), inbox: "Inbox" },
    dataDir: join(root, "data"),
    stt: { provider: "whisper-cpp" as const, url: "http://127.0.0.1:9" },
    server: { port: 0, adminToken: ADMIN, trustProxy: false },
    notify: { provider: "console" as const, ntfy: { url: "", topic: "" }, digestAt: "08:00" },
    safety: { allowUnbackedVault: false, dryRun: false },
  } as unknown as Config;
  const routes = createRoutes({
    config, db,
    vault: new Vault(config.vault.path, "Inbox", false, false),
    stt: { async transcribe() { return ""; }, async health() { return true; }, endpoint: "fake" } as unknown as Stt,
    retriever: new GrepRetriever(config.vault.path),
    llm: null, notifier: { name: "console", async send() {} }, onWrite: () => {},
  });
  return { routes, cleanup: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

test("an unknown well-known document is absent, not protected", async () => {
  // ChatGPT probes three discovery documents. Two are ours; `openid-configuration`
  // is not, and it used to fall through to the bearer gate and answer 401 with a
  // WWW-Authenticate challenge - "authenticate to read my discovery", which is
  // both untrue and the sort of thing that stops a connector proceeding.
  //
  // Observed in a real connection attempt: PRM 200, AS metadata 200,
  // openid-configuration 401, and the client then never called the token
  // endpoint at all.
  const f = await fixture();
  try {
    for (const p of ["/.well-known/openid-configuration", "/.well-known/oauth-protected-resource-x", "/.well-known/anything"]) {
      const res = await f.routes.handle(get(p));
      expect(res.status, p).toBe(404);
      expect(res.headers.get("www-authenticate"), p).toBeNull();
    }

    // The two that are ours still answer.
    expect((await f.routes.handle(get("/.well-known/oauth-protected-resource"))).status).toBe(200);
    expect((await f.routes.handle(get("/.well-known/oauth-authorization-server"))).status).toBe(200);
  } finally {
    await f.cleanup();
  }
});

test("a resubmitted consent says the approval worked, not that it failed", async () => {
  // The most common way to land on this page is success: the browser resubmits
  // the form after a back navigation, or after the client's callback bounced it
  // back. Reporting "expired or already used" sent every attempt to debug a
  // server that had already done exactly what it was asked - and it did, for
  // hours.
  const f = await fixture();
  try {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      response_type: "code", client_id: "https://claude.ai/oauth/client-metadata",
      redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", scope: "read",
    });
    const html = await (await f.routes.handle(get(`/oauth/authorize?${q}`))).text();
    const requestId = html.match(/name="request" value="([^"]+)"/)![1]!;

    // First submission works.
    const first = await f.routes.handle(form("/oauth/authorize", { request: requestId, admin: ADMIN, decision: "allow", scope: "read" }));
    expect(first.status).toBe(302);
    expect(new URL(first.headers.get("location")!).searchParams.get("code")).toBeTruthy();

    // Resubmitting the identical form is the case that used to read as a failure.
    const again = await f.routes.handle(form("/oauth/authorize", { request: requestId, admin: ADMIN, decision: "allow", scope: "read" }));
    expect(again.status).toBe(410);
    const text = await again.text();
    expect(text).toContain("already went through");
    expect(text).toContain("Nothing here failed");
    expect(text).not.toContain("expired");

    // A request this server never issued is a different answer again.
    const unknown = await f.routes.handle(form("/oauth/authorize", { request: "0".repeat(32), admin: ADMIN, decision: "allow", scope: "read" }));
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain("not one this server issued");
  } finally {
    await f.cleanup();
  }
});
