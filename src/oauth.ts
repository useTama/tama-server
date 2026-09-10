/**
 * OAuth 2.1, so a connector dialled from someone else's servers can get in.
 *
 * `tama expose --public` solved reachability. This is the other half: ChatGPT
 * and Claude custom connectors will not accept a static bearer token, and there
 * is nowhere in either UI to put one. They want an authorization code flow.
 *
 * ## The premise that changed
 *
 * `docs/mcp.md` §4 argued that OAuth "would be ceremony that protects nothing",
 * and that was right for a daemon on a loopback port. It stopped being right
 * when the same daemon grew a public hostname. This file is not a reversal of
 * that judgement; it is the same judgement applied to a deployment that did not
 * exist when it was made.
 *
 * ## tama is its own authorization server
 *
 * Delegating to an external identity provider would mean an account, probably a
 * bill, and a third party sitting between the owner and their own notes - the
 * three things the project's first line exists to avoid. So the resource server
 * and the authorization server are the same origin. That is unusual, and it is
 * explicitly permitted: OpenAI's connector documentation states the two may be
 * the same origin provided the endpoints are exposed, and RFC 8414 has never
 * required otherwise.
 *
 * It is also the shape the problem actually has. Most of what makes an
 * authorization server hard is having many resource owners. There is exactly
 * one here, they administer the box, and they already hold an admin token.
 *
 * ## Opaque tokens, in the table that already exists
 *
 * An access token is 32 random bytes, stored as a SHA-256 hash in `tokens`,
 * exactly like a device token. That one decision carries everything else for
 * free: an OAuth grant has a Grant, so views and capabilities apply; it appears
 * in the Devices list; `revokeToken` kills it; and the bearer check at the top
 * of routes.ts needs no second branch.
 *
 * No JWTs. The spec mandates audience validation, not a format, and a token
 * this server both issues and validates gains nothing from being self-describing
 * except a signing key to manage and an algorithm confusion bug to avoid.
 *
 * ## Registration: metadata documents first, DCR because clients still use it
 *
 * The current spec (2026-07-28) deprecates Dynamic Client Registration and
 * prefers Client ID Metadata Documents, where `client_id` is an https URL the
 * authorization server dereferences. Deprecated in a spec is not gone from
 * shipped clients, and OpenAI documents DCR as a supported alternative today,
 * so both are here.
 *
 * CIMD means fetching a URL a caller supplied, which on the reference EC2
 * deployment is a link-local metadata service one redirect away. So the fetch
 * is bounded by an origin allowlist checked BEFORE any DNS lookup, rather than
 * by trying to recognise bad addresses afterwards. That is not a weaker check
 * than IP filtering, it is a different shape: nothing outside the list is ever
 * resolved, let alone connected to.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CAPABILITIES, type Capability } from "./grants.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Authorization codes are exchanged within seconds. A minute is already generous. */
const CODE_TTL_MS = 60_000;
/** A parked request is abandoned if the owner never finishes consenting. */
const REQUEST_TTL_MS = 10 * 60_000;
/** Short, because refresh exists. Claude refreshes ~5 minutes before expiry. */
export const ACCESS_TTL_MS = 60 * 60_000;

/**
 * Where a hosted connector is allowed to send the owner back to.
 *
 * An exact-match list, not a pattern. A redirect URI is the one parameter that
 * decides where an authorization code is delivered, so a wildcard here is a
 * standing offer to hand somebody else's server a code for this vault. Extra
 * entries come from config, for a client that is neither of these.
 */
export const KNOWN_REDIRECTS = [
  // Claude custom connectors.
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  // ChatGPT, with and without issuer identification (RFC 9207). The second is
  // per-connector, so it is matched by prefix below rather than listed.
  "https://chatgpt.com/connector_platform_oauth_redirect",
] as const;

/** The one prefix match, because ChatGPT mints a callback id per connector. */
const CHATGPT_CALLBACK_PREFIX = "https://chatgpt.com/connector/oauth/";

/**
 * Origins whose Client ID Metadata Documents will be fetched.
 *
 * The spec permits domain-based trust policies for exactly this reason. Checked
 * before the URL is resolved, so a document URL pointing at 169.254.169.254 -
 * or at anything that redirects there - is refused without a packet leaving the
 * box.
 */
export const DEFAULT_CIMD_ORIGINS = ["https://claude.ai", "https://claude.com", "https://chatgpt.com"] as const;

export type OAuthConfig = {
  enabled: boolean;
  issuer: string;
  /** View names applied to every OAuth grant, resolved by the caller. */
  readView?: string;
  writeView?: string;
  cimdOrigins: string[];
  extraRedirects: string[];
};

/**
 * The issuer must be byte-identical to the origin a client built the well-known
 * URL from.
 *
 * Clients compare it as a string with no normalisation, so a trailing slash, a
 * path, or an upper-case letter is a mismatch that surfaces as an opaque
 * "invalid issuer" in somebody else's client. Checked at boot, where the
 * process has the config in front of it, rather than per request.
 */
export function assertIssuerUsable(issuer: string | undefined): asserts issuer is string {
  if (!issuer) {
    throw new Error(
      "oauth: server.publicBaseUrl must be set before OAuth can be enabled - it is the issuer, " +
        "and a connector has nowhere to send the owner without it. `tama expose --public DOMAIN` sets it.",
    );
  }
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error(`oauth: server.publicBaseUrl is not a URL: ${JSON.stringify(issuer)}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`oauth: the issuer must be https. Got ${url.protocol}//. A connector will refuse anything else.`);
  }
  for (const [what, bad] of [
    ["a path", url.pathname !== "/"],
    ["a query string", url.search !== ""],
    ["a fragment", url.hash !== ""],
    ["credentials", url.username !== "" || url.password !== ""],
  ] as const) {
    if (bad) {
      throw new Error(
        `oauth: the issuer must be a bare origin and this one has ${what}: ${issuer}. ` +
          "Clients compare the issuer as an exact string, so anything extra is a mismatch they report as an unrelated error.",
      );
    }
  }
  if (issuer.endsWith("/")) {
    throw new Error(
      `oauth: the issuer must not end in a slash: ${issuer}. It is compared byte for byte against what the client derived.`,
    );
  }
}

// ---- storage ---------------------------------------------------------------

export type PendingRequest = {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  resource: string | null;
  scope: string;
};

/**
 * Park the authorization request server-side and hand the browser only an
 * opaque id.
 *
 * The alternative - carrying redirect_uri, code_challenge, state and resource
 * through the consent page as hidden form fields - works only as long as the
 * POST re-validates every one of them against the same rules the GET used. That
 * is an invariant a comment has to keep true. Parking makes the class of bug
 * unrepresentable: the POST reads them back from the row and there is nothing
 * for a caller to tamper with. It also means the redirect host displayed on the
 * page cannot diverge from the one acted on.
 */
export function parkRequest(db: Database, r: Omit<PendingRequest, "id">): string {
  const id = randomBytes(16).toString("hex");
  db.query(
    `INSERT INTO oauth_requests (id, client_id, client_name, redirect_uri, code_challenge, state, resource, scope, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, r.clientId, r.clientName, r.redirectUri, r.codeChallenge, r.state, r.resource, r.scope, new Date().toISOString());
  return id;
}

export function readRequest(db: Database, id: string): PendingRequest | null {
  const row = db
    .query("SELECT * FROM oauth_requests WHERE id = ? AND consumed_at IS NULL")
    .get(id) as any;
  if (!row) return null;
  if (Date.now() - Date.parse(row.created_at) > REQUEST_TTL_MS) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    state: row.state,
    resource: row.resource,
    scope: row.scope,
  };
}

/**
 * Turn a consented request into a code, atomically.
 *
 * `WHERE consumed_at IS NULL` plus a changes check, rather than read-then-write:
 * two consent POSTs racing must not both produce a usable code for one approval.
 */
export function issueCode(db: Database, requestId: string, scope: string): string | null {
  const code = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  const r = db
    .query("UPDATE oauth_requests SET consumed_at = ?, code_hash = ?, granted_scope = ? WHERE id = ? AND consumed_at IS NULL")
    .run(now, sha256(code), scope, requestId);
  return r.changes === 1 ? code : null;
}

export type RedeemedCode = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scope: string;
};

/**
 * Exchange a code exactly once.
 *
 * The row is deleted rather than flagged, so a replayed code cannot be
 * distinguished from one that never existed - and cannot be replayed at all.
 */
export function redeemCode(db: Database, code: string): RedeemedCode | null {
  const row = db.query("SELECT * FROM oauth_requests WHERE code_hash = ?").get(sha256(code)) as any;
  if (!row) return null;
  const deleted = db.query("DELETE FROM oauth_requests WHERE code_hash = ?").run(sha256(code));
  if (deleted.changes !== 1) return null;
  if (Date.now() - Date.parse(row.consumed_at) > CODE_TTL_MS) return null;
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    scope: row.granted_scope ?? row.scope,
  };
}

export function sweepOAuth(db: Database): void {
  const cutoff = new Date(Date.now() - REQUEST_TTL_MS).toISOString();
  db.query("DELETE FROM oauth_requests WHERE created_at < ?").run(cutoff);
}

// ---- PKCE ------------------------------------------------------------------

/** base64url of the SHA-256 of the verifier, per RFC 7636 S256. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!verifier || !challenge) return false;
  const computed = createHash("sha256").update(verifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---- clients ---------------------------------------------------------------

/**
 * Whether this is somewhere a code may be delivered.
 *
 * Exact match against the known list and anything the owner added, plus the one
 * prefix ChatGPT needs because it mints a callback id per connector. The prefix
 * is anchored to a full origin and path, so it cannot be widened by a crafted
 * host.
 */
export function redirectAllowed(uri: string, extra: string[] = []): boolean {
  if (KNOWN_REDIRECTS.includes(uri as (typeof KNOWN_REDIRECTS)[number])) return true;
  if (extra.includes(uri)) return true;
  if (uri.startsWith(CHATGPT_CALLBACK_PREFIX) && !uri.slice(CHATGPT_CALLBACK_PREFIX.length).includes("/")) return true;
  return false;
}

/** Is this client_id a metadata document URL we are willing to dereference? */
export function cimdAllowed(clientId: string, origins: string[]): boolean {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return origins.includes(url.origin);
}

/**
 * Fetch a Client ID Metadata Document.
 *
 * Bounded on every axis that matters: the origin was checked before this was
 * called, redirects are refused outright rather than followed (a permitted
 * origin that redirects elsewhere is the whole attack), there is a timeout, and
 * the body is capped before it is parsed.
 */
export async function fetchCimd(
  clientId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ name: string; redirectUris: string[] } | null> {
  try {
    const res = await fetchImpl(clientId, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const text = (await res.text()).slice(0, 64 * 1024);
    const doc = JSON.parse(text) as { client_name?: string; client_id?: string; redirect_uris?: unknown };
    // The document must claim the identity it was fetched from, or one document
    // could vouch for a client_id it does not own.
    if (doc.client_id && doc.client_id !== clientId) return null;
    const uris = Array.isArray(doc.redirect_uris) ? doc.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    return { name: typeof doc.client_name === "string" ? doc.client_name.slice(0, 120) : clientId, redirectUris: uris };
  } catch {
    return null;
  }
}

// ---- scopes ----------------------------------------------------------------

/**
 * The scope strings this server understands, which are exactly its capabilities.
 *
 * `offline_access` is deliberately absent here and present in the authorization
 * server metadata. It is not a permission over the resource - it is a request
 * for a refresh token - so advertising it as a resource scope would be wrong,
 * and omitting it from the AS metadata is what stops a client asking for one.
 */
export const OAUTH_SCOPES: readonly Capability[] = CAPABILITIES;
export const OFFLINE_ACCESS = "offline_access";

/**
 * Keep only scopes this server knows, and drop the rest silently.
 *
 * `parseCaps` throws on an unknown capability, on purpose - a typo in a config
 * file should fail loudly. A scope string arriving from a third-party client is
 * the opposite case: `offline_access` is legitimate and means nothing to the
 * resource, and letting it reach `parseCaps` would surface as a 403 saying the
 * device is no longer configured, which points a debugging owner at entirely
 * the wrong thing.
 */
export function usableScopes(requested: string | null | undefined): Capability[] {
  if (!requested) return [];
  const asked = requested.split(/[\s+]+/).map((s) => s.trim()).filter(Boolean);
  return OAUTH_SCOPES.filter((c) => asked.includes(c));
}

// ---- metadata documents ----------------------------------------------------

/** RFC 9728. Fetched by a client after a 401, before it holds anything. */
export function protectedResourceMetadata(issuer: string): Record<string, unknown> {
  return {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    // Not offline_access: that is a request for a refresh token, not a
    // permission over these notes.
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/useTama/tama-server/blob/main/docs/mcp.md",
  };
}

/** RFC 8414, plus the two fields that decide how a client registers. */
export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only. `plain` is a downgrade and OAuth 2.1 removed it.
    code_challenge_methods_supported: ["S256"],
    // Both of these, or a client silently falls back to dynamic registration:
    // the metadata document path is selected only when the server advertises
    // support AND accepts an unauthenticated token request.
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    // RFC 9207. Earns ChatGPT's stable redirect URI instead of a per-connector
    // one, which is the difference between an allowlist entry and a wildcard.
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [...OAUTH_SCOPES, OFFLINE_ACCESS],
  };
}

/**
 * The challenge a 401 from the MCP route carries.
 *
 * Without `resource_metadata` a client has nowhere to begin: it knows it was
 * refused and not where to ask. This is the entire discovery entry point.
 */
export function bearerChallenge(issuer: string, error?: string, description?: string): string {
  const parts = [`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  return parts.join(", ");
}
