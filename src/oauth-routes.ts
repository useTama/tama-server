/**
 * The OAuth endpoints, as one function that either answers or declines.
 *
 * Separate from routes.ts because that file is already the longest in the
 * project and this is a self-contained protocol surface: seven paths that share
 * a vocabulary with each other and almost nothing with `/capture`.
 *
 * Every route here is reachable without a credential, and that is not an
 * oversight in any of them:
 *
 *   the metadata documents  a client fetches them to discover how to ask
 *   GET  /oauth/authorize   the owner arrives in a browser with no header
 *   POST /oauth/authorize   carries the admin token in its body
 *   POST /oauth/token       the code plus the PKCE verifier are the proof
 *   POST /oauth/register    registration is by definition pre-credential
 *   POST /oauth/revoke      possession of the token is the proof
 *
 * The one that would be a mistake to leave open is the consent POST, and it is
 * the one that checks the admin token.
 */

import type { Database } from "bun:sqlite";
import type { Config } from "./config.ts";
import { adminTokenOk, mintToken, revokeByToken } from "./auth.ts";
import { CAPABILITIES, serialiseCaps, type Capability } from "./grants.ts";
import { CONSENT_HEADERS, renderConsent } from "./consent-page.ts";
import {
  ACCESS_TTL_MS,
  authorizationServerMetadata,
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
} from "./oauth.ts";
import { createHash, randomBytes } from "node:crypto";
import { grey, orange } from "./ui.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export type OAuthDeps = {
  db: Database;
  config: Config;
  /** The resolved issuer. Validated at boot by assertIssuerUsable. */
  issuer: string;
  /** Injectable so a test never reaches the network. */
  fetchImpl?: typeof fetch;
};

const json = (b: unknown, s = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b, null, 2) + "\n", {
    status: s,
    // no-store on every one of these: they carry tokens, or say where to get one.
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });

/** An OAuth error response, in the shape RFC 6749 §5.2 defines. */
const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

/**
 * Send the owner back to the client with an error, rather than showing it here.
 *
 * Only ever used once the redirect URI has been validated - an error delivered
 * to an unvalidated redirect is the same disclosure as a code delivered there.
 */
function redirectError(redirectUri: string, state: string | null, issuer: string, error: string, description: string): Response {
  const to = new URL(redirectUri);
  to.searchParams.set("error", error);
  to.searchParams.set("error_description", description);
  if (state) to.searchParams.set("state", state);
  to.searchParams.set("iss", issuer);
  return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
}

/** The extra callbacks and CIMD origins an owner has added, with defaults. */
const extraRedirects = (config: Config): string[] => config.server.oauth?.extraRedirects ?? [];
const cimdOrigins = (config: Config): string[] => config.server.oauth?.cimdOrigins ?? [...DEFAULT_CIMD_ORIGINS];

/**
 * Establish who is asking, from a `client_id` that is either a metadata
 * document URL or something an owner pre-registered.
 *
 * A name only. Nothing here grants anything - the redirect URI is what is
 * actually validated, and it is validated separately against the allowlist
 * whatever the document says. A metadata document listing a redirect URI does
 * not make that URI acceptable; it can only fail to list one that is.
 */
async function identifyClient(
  clientId: string,
  deps: OAuthDeps,
): Promise<{ name: string } | null> {
  if (!clientId) return null;
  if (cimdAllowed(clientId, cimdOrigins(deps.config))) {
    const doc = await fetchCimd(clientId, deps.fetchImpl ?? fetch);
    if (doc) return { name: doc.name };
    // A permitted origin that did not serve a usable document. Fall through to
    // the label rather than refusing: the redirect allowlist is the real gate,
    // and refusing here would break a connector over a transient 502.
  }
  // Anything else is displayed verbatim and trusted for nothing. Truncated
  // because it is about to be rendered into a page.
  return { name: clientId.slice(0, 120) };
}

export async function handleOAuth(req: Request, url: URL, deps: OAuthDeps): Promise<Response | null> {
  const { db, config, issuer } = deps;
  const path = url.pathname;

  // ---- discovery ----------------------------------------------------------

  // Served at both paths. RFC 9728 derives the second from the resource URL
  // (`/mcp` appended to the well-known prefix); the bare one is what several
  // clients ask for first. Answering both costs nothing and saves a failure
  // that looks like "your server does not do OAuth".
  if (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp") {
    return json(protectedResourceMetadata(issuer));
  }
  if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp") {
    return json(authorizationServerMetadata(issuer));
  }

  // ---- authorize ----------------------------------------------------------

  if (path === "/oauth/authorize" && req.method === "GET") {
    const q = url.searchParams;
    const clientId = q.get("client_id") ?? "";
    const redirectUri = q.get("redirect_uri") ?? "";
    const challenge = q.get("code_challenge") ?? "";

    // Refused HERE, not redirected: without a validated redirect there is
    // nowhere safe to send an error, and sending one anyway is how an
    // authorization server becomes an open redirector.
    if (!redirectAllowed(redirectUri, extraRedirects(config))) {
      console.error(`${orange("oauth")} refused redirect_uri ${JSON.stringify(redirectUri)}`);
      return oauthError(
        "invalid_request",
        "that redirect_uri is not one this server will send a code to. Add it to server.oauth.extraRedirects if it is yours.",
      );
    }
    const state = q.get("state");
    if (q.get("response_type") !== "code") {
      return redirectError(redirectUri, state, issuer, "unsupported_response_type", "only the authorization code flow is supported");
    }
    // S256 only. OAuth 2.1 removed `plain`, and accepting a missing challenge
    // would make the whole exchange interceptable.
    if (!challenge || (q.get("code_challenge_method") ?? "S256") !== "S256") {
      return redirectError(redirectUri, state, issuer, "invalid_request", "PKCE with code_challenge_method=S256 is required");
    }

    const resource = q.get("resource");
    // RFC 8707. A token is minted for one resource; a request naming a
    // different one is asking for a token this server has no business issuing.
    if (resource && resource !== `${issuer}/mcp`) {
      return redirectError(redirectUri, state, issuer, "invalid_target", `this server only issues tokens for ${issuer}/mcp`);
    }

    const client = await identifyClient(clientId, deps);
    if (!client) return oauthError("invalid_request", "client_id is required");

    const asked = usableScopes(q.get("scope"));
    const offered = asked.length ? asked : [...CAPABILITIES];
    const requestId = parkRequest(db, {
      clientId,
      clientName: client.name,
      redirectUri,
      codeChallenge: challenge,
      state,
      resource: resource ?? `${issuer}/mcp`,
      scope: offered.join(" "),
    });

    return new Response(
      renderConsent({
        requestId,
        clientName: client.name,
        redirectHost: new URL(redirectUri).host,
        offered,
        // Only ever `read`. The requested set is client-controlled, and a
        // pre-ticked box is a decision the owner did not make.
        preTicked: ["read"],
      }),
      { headers: CONSENT_HEADERS },
    );
  }

  if (path === "/oauth/authorize" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    if (!form) return oauthError("invalid_request", "expected a form submission");

    const parked = readRequest(db, String(form.get("request") ?? ""));
    if (!parked) {
      return new Response("That authorisation request has expired or was already used. Start again from the client.", {
        status: 400,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }

    // The one authenticated route in this file. Everything below acts on the
    // parked row, so nothing a caller can edit reaches the decision.
    if (!adminTokenOk(String(form.get("admin") ?? ""), config.server.adminToken)) {
      console.error(`${orange("oauth")} consent refused: wrong admin token for ${parked.clientName}`);
      return new Response(
        renderConsent({
          requestId: parked.id,
          clientName: parked.clientName,
          redirectHost: new URL(parked.redirectUri).host,
          offered: usableScopes(parked.scope),
          preTicked: [],
          error: "That admin token was not right. Nothing has been granted.",
        }),
        { status: 401, headers: CONSENT_HEADERS },
      );
    }

    if (form.get("decision") !== "allow") {
      return redirectError(parked.redirectUri, parked.state, issuer, "access_denied", "the owner declined");
    }

    // Intersected with what was parked, so a tampered form cannot widen the
    // request beyond what the client asked for and the page displayed.
    const ticked = form.getAll("scope").map(String);
    const granted = usableScopes(parked.scope).filter((c) => ticked.includes(c));
    if (granted.length === 0) {
      return redirectError(parked.redirectUri, parked.state, issuer, "access_denied", "nothing was granted");
    }

    const code = issueCode(db, parked.id, granted.join(" "));
    if (!code) return redirectError(parked.redirectUri, parked.state, issuer, "server_error", "that request was already used");

    const to = new URL(parked.redirectUri);
    to.searchParams.set("code", code);
    if (parked.state) to.searchParams.set("state", parked.state);
    // RFC 9207. Advertised in the metadata, so it must actually be sent.
    to.searchParams.set("iss", issuer);
    console.log(`${grey("oauth")} granted ${granted.join(",")} to ${parked.clientName}`);
    return new Response(null, { status: 302, headers: { location: to.toString(), "cache-control": "no-store" } });
  }

  // ---- token --------------------------------------------------------------

  if (path === "/oauth/token" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    if (!form) return oauthError("invalid_request", "expected application/x-www-form-urlencoded");
    const grantType = String(form.get("grant_type") ?? "");

    if (grantType === "refresh_token") {
      const { rotateRefresh } = await import("./auth.ts");
      const rotated = rotateRefresh(db, String(form.get("refresh_token") ?? ""), ACCESS_TTL_MS);
      // Unknown, already rotated, and revoked are one answer. Telling them
      // apart tells a holder of a stolen refresh token which it is.
      if (!rotated) return oauthError("invalid_grant", "that refresh token is not usable");
      return json({
        access_token: rotated.accessToken,
        refresh_token: rotated.refreshToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      });
    }

    if (grantType !== "authorization_code") {
      return oauthError("unsupported_grant_type", "authorization_code and refresh_token only");
    }

    const redeemed = redeemCode(db, String(form.get("code") ?? ""));
    if (!redeemed) return oauthError("invalid_grant", "that code is not usable");

    // The redirect URI is repeated at the token endpoint and must match the one
    // the code was issued against, or a code intercepted at one callback could
    // be exchanged by a client claiming another.
    if (String(form.get("redirect_uri") ?? "") !== redeemed.redirectUri) {
      return oauthError("invalid_grant", "redirect_uri does not match the one the code was issued for");
    }
    if (!pkceMatches(String(form.get("code_verifier") ?? ""), redeemed.codeChallenge)) {
      return oauthError("invalid_grant", "the PKCE verifier does not match");
    }

    const granted = usableScopes(redeemed.scope);
    // Refused rather than minted. A client can ask for only `offline_access`,
    // which usableScopes correctly drops, and an owner can untick every box -
    // both leave nothing granted. Minting on an empty set used to produce an
    // unrestricted owner token, which is the opposite of what was consented to.
    // parseCaps now refuses that column outright; this is the same refusal said
    // in OAuth's own vocabulary, so the connector is told why rather than
    // meeting a 403 on its first tool call.
    if (granted.length === 0) {
      return oauthError("invalid_scope", "no capability was granted, so there is no token to issue");
    }
    // Always issued, rather than only when offline_access was requested. The
    // access token lives an hour; without a refresh token the connector would
    // send the owner back through the consent screen every hour, and a client
    // that did not ask for one can simply not use it.
    const refreshToken = randomBytes(32).toString("hex");

    const { token, id } = mintToken(db, redeemed.clientName.slice(0, 64), {
      caps: serialiseCaps(new Set(granted)) ?? undefined,
      ...(config.server.oauth?.readView ? { readView: config.server.oauth.readView } : {}),
      ...(config.server.oauth?.writeView ? { writeView: config.server.oauth.writeView } : {}),
      expiresAt: new Date(Date.now() + ACCESS_TTL_MS).toISOString(),
      resource: redeemed.resource ?? `${issuer}/mcp`,
      clientId: redeemed.clientId,
      refreshHash: sha256(refreshToken),
    });

    console.log(`${grey("oauth")} issued ${id} to ${redeemed.clientName} (${granted.join(",") || "nothing"})`);
    return json({
      access_token: token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      scope: granted.join(" "),
      refresh_token: refreshToken,
    });
  }

  // ---- registration -------------------------------------------------------

  if (path === "/oauth/register" && req.method === "POST") {
    // Deprecated in the 2026-07-28 spec in favour of metadata documents, and
    // kept because deprecated in a spec is not gone from shipped clients -
    // OpenAI documents it as a supported alternative today.
    //
    // Stateless: no client row is created, because nothing about a registration
    // is trusted later. The redirect URIs are validated against the same
    // allowlist /authorize uses, and the client_id handed back is derived from
    // them, so a "registration" is really just an echo that proves the caller
    // named a callback this server would have accepted anyway.
    const body = (await req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = Array.isArray(body?.redirect_uris) ? body!.redirect_uris.filter((u): u is string => typeof u === "string") : [];
    if (uris.length === 0) return oauthError("invalid_redirect_uri", "redirect_uris is required");
    const bad = uris.find((u) => !redirectAllowed(u, extraRedirects(config)));
    if (bad) return oauthError("invalid_redirect_uri", `this server will not send a code to ${bad}`);

    const name = typeof body?.client_name === "string" ? body.client_name.slice(0, 120) : "a connector";
    return json(
      {
        client_id: `urn:tama:client:${sha256(uris.slice().sort().join(" ")).slice(0, 32)}`,
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  }

  // ---- revocation ---------------------------------------------------------

  if (path === "/oauth/revoke" && req.method === "POST") {
    const form = await req.formData().catch(() => null);
    const token = String(form?.get("token") ?? "");
    if (token) revokeByToken(db, token);
    // RFC 7009: 200 whether or not it existed. A different answer for an
    // unknown token turns this into an oracle for guessing them.
    return json({});
  }

  return null;
}
