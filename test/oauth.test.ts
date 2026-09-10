/**
 * The OAuth layer, where a subtle bug is somebody else reading the vault.
 *
 * Weighted toward the four decisions that carry the security of the whole
 * flow - where a code may be delivered, that a code works once, that PKCE is
 * actually compared, and that a token minted for this server is refused
 * elsewhere - rather than spread evenly over the surface.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { openDb } from "../src/db.ts";
import { mintToken, verifyToken, revokeToken, revokeByToken, rotateRefresh } from "../src/auth.ts";
import {
  ACCESS_TTL_MS,
  assertIssuerUsable,
  authorizationServerMetadata,
  bearerChallenge,
  cimdAllowed,
  DEFAULT_CIMD_ORIGINS,
  fetchCimd,
  issueCode,
  parkRequest,
  pkceMatches,
  protectedResourceMetadata,
  readRequest,
  redeemCode,
  redirectAllowed,
  usableScopes,
} from "../src/oauth.ts";

const ISSUER = "https://tama.example.com";

async function db() {
  const dir = await mkdtemp(join(tmpdir(), "tama-oauth-"));
  const database = openDb(join(dir, "t.db"));
  return { db: database, cleanup: async () => { database.close(); await rm(dir, { recursive: true, force: true }); } };
}

const park = (d: ReturnType<typeof openDb>, over: Partial<Parameters<typeof parkRequest>[1]> = {}) =>
  parkRequest(d, {
    clientId: "https://claude.ai/oauth/client",
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    codeChallenge: "chal",
    state: "st",
    resource: `${ISSUER}/mcp`,
    scope: "read",
    ...over,
  });

// ---- issuer ---------------------------------------------------------------

test("the issuer must be a bare https origin, checked at boot", () => {
  // Clients compare it byte for byte against the origin they derived the
  // well-known URL from, with no normalisation. Every one of these is a
  // mismatch the client reports as something unrelated.
  expect(() => assertIssuerUsable(ISSUER)).not.toThrow();
  expect(() => assertIssuerUsable(undefined)).toThrow(/publicBaseUrl must be set/);
  expect(() => assertIssuerUsable("http://tama.example.com")).toThrow(/must be https/);
  expect(() => assertIssuerUsable("https://tama.example.com/")).toThrow(/slash/);
  expect(() => assertIssuerUsable("https://tama.example.com/mcp")).toThrow(/a path/);
  expect(() => assertIssuerUsable("https://tama.example.com?x=1")).toThrow(/query/);
  expect(() => assertIssuerUsable("https://u:p@tama.example.com")).toThrow(/credentials/);
  expect(() => assertIssuerUsable("not a url")).toThrow(/not a URL/);
});

// ---- redirect allowlist ---------------------------------------------------

test("a code is only ever delivered to a known callback", () => {
  // The one parameter that decides where an authorization code goes. A wildcard
  // here is a standing offer to hand someone else's server a code for this vault.
  expect(redirectAllowed("https://claude.ai/api/mcp/auth_callback")).toBe(true);
  expect(redirectAllowed("https://chatgpt.com/connector_platform_oauth_redirect")).toBe(true);
  // ChatGPT mints a callback id per connector, so this one is a prefix - and
  // the prefix must not be wideable.
  expect(redirectAllowed("https://chatgpt.com/connector/oauth/abc123")).toBe(true);
  expect(redirectAllowed("https://chatgpt.com/connector/oauth/abc/../../evil")).toBe(false);
  expect(redirectAllowed("https://chatgpt.com/connector/oauth/a/b")).toBe(false);

  for (const bad of [
    "https://evil.example.com/cb",
    "https://claude.ai.evil.example.com/api/mcp/auth_callback",
    "http://claude.ai/api/mcp/auth_callback",
    "https://claude.ai/api/mcp/auth_callback/extra",
    "",
  ]) {
    expect(redirectAllowed(bad), bad || "<empty>").toBe(false);
  }

  // An owner may add one for a client that is neither vendor.
  expect(redirectAllowed("https://mine.example.com/cb", ["https://mine.example.com/cb"])).toBe(true);
});

// ---- PKCE -----------------------------------------------------------------

test("PKCE is actually compared, S256 only", () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  expect(pkceMatches(verifier, challenge)).toBe(true);
  expect(pkceMatches(verifier + "x", challenge)).toBe(false);
  expect(pkceMatches("", challenge)).toBe(false);
  expect(pkceMatches(verifier, "")).toBe(false);
  // The plain challenge method is a downgrade OAuth 2.1 removed: a verifier
  // presented as its own challenge must not pass.
  expect(pkceMatches(verifier, verifier)).toBe(false);
});

// ---- codes ----------------------------------------------------------------

test("an authorization code works exactly once", async () => {
  const { db: d, cleanup } = await db();
  try {
    const id = park(d);
    const code = issueCode(d, id, "read")!;
    expect(code).toBeTruthy();

    const first = redeemCode(d, code);
    expect(first?.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback");
    // Replay is indistinguishable from a code that never existed, because the
    // row is deleted rather than flagged.
    expect(redeemCode(d, code)).toBeNull();
  } finally {
    await cleanup();
  }
});

test("one approval cannot yield two codes", async () => {
  // Two consent POSTs racing. The UPDATE is guarded on consumed_at IS NULL and
  // checks `changes`, so exactly one wins.
  const { db: d, cleanup } = await db();
  try {
    const id = park(d);
    expect(issueCode(d, id, "read")).toBeTruthy();
    expect(issueCode(d, id, "read")).toBeNull();
  } finally {
    await cleanup();
  }
});

test("a parked request carries the parameters, so the consent POST cannot be tampered with", async () => {
  const { db: d, cleanup } = await db();
  try {
    const id = park(d, { state: "opaque-state", resource: `${ISSUER}/mcp` });
    const back = readRequest(d, id)!;
    expect(back.redirectUri).toBe("https://claude.ai/api/mcp/auth_callback");
    expect(back.state).toBe("opaque-state");
    expect(back.resource).toBe(`${ISSUER}/mcp`);
    expect(readRequest(d, "nope")).toBeNull();
  } finally {
    await cleanup();
  }
});

// ---- tokens ---------------------------------------------------------------

test("an access token expires and then reads as absent", async () => {
  const { db: d, cleanup } = await db();
  try {
    const live = mintToken(d, "Claude", { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(verifyToken(d, live.token)?.deviceName).toBe("Claude");

    const dead = mintToken(d, "Claude", { expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(verifyToken(d, dead.token)).toBeNull();

    // A device token has no expiry and must keep working forever.
    const device = mintToken(d, "laptop");
    expect(verifyToken(d, device.token)?.deviceName).toBe("laptop");
  } finally {
    await cleanup();
  }
});

test("a token bound to one resource is refused at another", async () => {
  const { db: d, cleanup } = await db();
  try {
    const bound = mintToken(d, "Claude", { resource: `${ISSUER}/mcp` });
    expect(verifyToken(d, bound.token, `${ISSUER}/mcp`)?.deviceName).toBe("Claude");
    expect(verifyToken(d, bound.token, "https://someone-else.example.com/mcp")).toBeNull();

    // A device token is not audience-bound, which is what it has always meant,
    // and is the whole coexistence story: one nullable column, no branch.
    const device = mintToken(d, "laptop");
    expect(verifyToken(d, device.token, "https://anything.example.com/mcp")?.deviceName).toBe("laptop");
  } finally {
    await cleanup();
  }
});

test("refreshing rotates both halves and the old refresh token dies", async () => {
  const { db: d, cleanup } = await db();
  try {
    const refresh = randomBytes(32).toString("hex");
    const minted = mintToken(d, "Claude", {
      expiresAt: new Date(Date.now() + 1000).toISOString(),
      refreshHash: createHash("sha256").update(refresh).digest("hex"),
    });

    const rotated = rotateRefresh(d, refresh, ACCESS_TTL_MS)!;
    expect(rotated.id).toBe(minted.id);
    expect(verifyToken(d, rotated.accessToken)?.deviceName).toBe("Claude");
    // The row is the connection for its whole life, so the id in Devices does
    // not change under the owner when a connector refreshes.
    expect(rotated.refreshToken).not.toBe(refresh);
    expect(rotateRefresh(d, refresh, ACCESS_TTL_MS)).toBeNull();

    // Revoking the id the owner sees kills the refresh family too - there is no
    // second table holding a credential that outlives it.
    expect(revokeToken(d, minted.id)).toBe(true);
    expect(rotateRefresh(d, rotated.refreshToken, ACCESS_TTL_MS)).toBeNull();
    expect(verifyToken(d, rotated.accessToken)).toBeNull();
  } finally {
    await cleanup();
  }
});

test("revocation works from either half of the pair", async () => {
  const { db: d, cleanup } = await db();
  try {
    const refresh = randomBytes(32).toString("hex");
    const minted = mintToken(d, "Claude", {
      refreshHash: createHash("sha256").update(refresh).digest("hex"),
    });
    // RFC 7009 lets a client present either one.
    expect(revokeByToken(d, refresh)).toBe(true);
    expect(verifyToken(d, minted.token)).toBeNull();
  } finally {
    await cleanup();
  }
});

// ---- scopes ---------------------------------------------------------------

test("unknown scopes are dropped rather than thrown on", () => {
  // parseCaps throws by design, so a config typo fails loudly. A scope string
  // from a third party is the opposite case: offline_access is legitimate,
  // means nothing to the resource, and reaching parseCaps would surface as
  // "this device is no longer configured" - pointing a debugging owner at
  // entirely the wrong thing.
  expect(usableScopes("read write offline_access")).toEqual(["read", "write"]);
  expect(usableScopes("offline_access")).toEqual([]);
  expect(usableScopes("nonsense")).toEqual([]);
  expect(usableScopes(null)).toEqual([]);
  expect(usableScopes("read+write")).toEqual(["read", "write"]);
});

// ---- metadata -------------------------------------------------------------

test("the two metadata documents say what a client needs to select the right path", () => {
  const as = authorizationServerMetadata(ISSUER);
  // Both of these, or a client silently falls back to dynamic registration.
  expect(as.client_id_metadata_document_supported).toBe(true);
  expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
  // S256 only: `plain` is the downgrade OAuth 2.1 removed.
  expect(as.code_challenge_methods_supported).toEqual(["S256"]);
  expect(as.issuer).toBe(ISSUER);
  // RFC 9207, which earns the stable ChatGPT callback rather than a per-connector one.
  expect(as.authorization_response_iss_parameter_supported).toBe(true);
  // offline_access here, because this is the switch that makes a client ask for
  // a refresh token at all.
  expect(as.scopes_supported).toContain("offline_access");

  const prm = protectedResourceMetadata(ISSUER);
  expect(prm.resource).toBe(`${ISSUER}/mcp`);
  expect(prm.authorization_servers).toEqual([ISSUER]);
  // ...and NOT here: offline_access is a request for a refresh token, not a
  // permission over these notes.
  expect(prm.scopes_supported).not.toContain("offline_access");
});

test("the 401 challenge points at the metadata document", () => {
  // Without resource_metadata a client knows only that it was refused, and not
  // where to ask. This is the entire discovery entry point.
  const c = bearerChallenge(ISSUER, "invalid_token", 'expired "quoted"');
  expect(c).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`);
  expect(c).toContain('error="invalid_token"');
  // A quote in the description would terminate the header value early.
  expect(c).not.toContain('"quoted"');
});

// ---- CIMD -----------------------------------------------------------------

test("only allowlisted origins are ever dereferenced", () => {
  const origins = [...DEFAULT_CIMD_ORIGINS];
  expect(cimdAllowed("https://claude.ai/oauth/client-metadata", origins)).toBe(true);
  expect(cimdAllowed("https://chatgpt.com/whatever", origins)).toBe(true);

  // The reason this is an allowlist and not a filter: on the reference EC2 box
  // the link-local metadata service is one fetch away.
  for (const bad of [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
    "http://claude.ai/oauth/client-metadata",
    "https://claude.ai.evil.example.com/x",
    "https://evil.example.com/x",
    "file:///etc/passwd",
    "not-a-url",
  ]) {
    expect(cimdAllowed(bad, origins), bad).toBe(false);
  }
});

test("a metadata document must claim the identity it was fetched from", async () => {
  const url = "https://claude.ai/oauth/client-metadata";
  const ok = await fetchCimd(url, (async () =>
    new Response(JSON.stringify({ client_id: url, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }), { status: 200 })) as unknown as typeof fetch);
  expect(ok?.name).toBe("Claude");

  // Otherwise one document could vouch for a client_id it does not own.
  const lying = await fetchCimd(url, (async () =>
    new Response(JSON.stringify({ client_id: "https://evil.example.com/x", client_name: "Claude" }), { status: 200 })) as unknown as typeof fetch);
  expect(lying).toBeNull();

  const missing = await fetchCimd(url, (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch);
  expect(missing).toBeNull();

  const garbage = await fetchCimd(url, (async () => new Response("{{{", { status: 200 })) as unknown as typeof fetch);
  expect(garbage).toBeNull();
});
