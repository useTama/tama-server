/**
 * The page where the owner decides whether a connector gets into their notes.
 *
 * The second HTML page this server has ever had, and the first where a human
 * grants something. It copies the pairing page's headers with exactly one
 * change - `form-action 'self'` rather than `'none'`, because this one has a
 * form to submit and `'none'` would produce an Allow button that silently does
 * nothing.
 *
 * ## What it deliberately does not say
 *
 * The GET is reachable by anyone who can construct an authorization request, so
 * everything rendered here is public. That rules out view names (they are vault
 * structure - `Clients/Acme` names a client), note counts, and any preview of
 * what would be shared. The page describes the *shape* of the access in
 * capability words, which are already published in the metadata document, and
 * nothing about the contents of the vault.
 *
 * ## Why it asks for the admin token
 *
 * Somebody has to prove they are the owner before an approval means anything,
 * and this server has no session, no login and one credential that already
 * means "administers this box". A browser cannot set an Authorization header on
 * a plain navigation, which is the same constraint the pairing page hit. The
 * difference is that the token is posted in a form body here rather than
 * carried in a query string, so it stays out of history, logs and referrers.
 */

import { escapeXml as escapeHtml } from "./qr.ts";
import type { Capability } from "./grants.ts";
import { CHATGPT_CALLBACK_PREFIX, KNOWN_REDIRECTS } from "./oauth.ts";

export type ConsentView = {
  requestId: string;
  clientName: string;
  /** Shown so the owner can see where a code would be sent. Host only. */
  redirectHost: string;
  /** The capabilities on offer, in the order they should be read. */
  offered: Capability[];
  /** Pre-ticked. Only ever `read`. */
  preTicked: readonly Capability[];
  error?: string;
};

/** What each capability actually lets a connector do, in the owner's terms. */
const MEANS: Record<Capability, string> = {
  read: "Search your notes and read them",
  write: "Add to your notes and file session logs",
  ask: "Spend model calls on your key to answer questions",
  capture: "Record new voice notes into the vault",
};

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2.5rem 1.25rem;
         display: flex; justify-content: center; }
  main { max-width: 34rem; width: 100%; }
  h1 { font-size: 1.4rem; margin: 0 0 .35rem; }
  .who { font-weight: 600; }
  .muted { opacity: .7; }
  .small { font-size: .875rem; }
  ul { list-style: none; padding: 0; margin: 1.25rem 0; }
  li { padding: .6rem 0; border-top: 1px solid rgba(128,128,128,.28); }
  li:last-child { border-bottom: 1px solid rgba(128,128,128,.28); }
  label { display: flex; gap: .7rem; align-items: flex-start; cursor: pointer; }
  .code { font-family: ui-monospace, monospace; }
  .row { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .6rem 1.1rem; border-radius: .4rem; cursor: pointer;
           border: 1px solid rgba(128,128,128,.5); background: transparent; }
  button.deny { flex: 1; font-weight: 600; }
  input[type=password] { font: inherit; padding: .5rem .6rem; width: 100%; box-sizing: border-box;
                         border: 1px solid rgba(128,128,128,.5); border-radius: .4rem; background: transparent; }
  .err { padding: .6rem .75rem; border: 1px solid rgba(190,60,60,.6); border-radius: .4rem; margin-bottom: 1.25rem; }
`;

export function renderConsent(v: ConsentView): string {
  const rows = v.offered
    .map((cap) => {
      const checked = v.preTicked.includes(cap) ? " checked" : "";
      return `<li><label>
        <input type="checkbox" name="scope" value="${escapeHtml(cap)}"${checked}>
        <span>${escapeHtml(MEANS[cap])}<br><span class="muted small code">${escapeHtml(cap)}</span></span>
      </label></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Authorise ${escapeHtml(v.clientName)}</title>
<style>${STYLE}</style>
</head><body><main>
${v.error ? `<div class="err">${escapeHtml(v.error)}</div>` : ""}
<h1><span class="who">${escapeHtml(v.clientName)}</span> is asking to reach your notes</h1>
<p class="muted small">It will be sent back to <span class="code">${escapeHtml(v.redirectHost)}</span>.
Tick only what it needs. You can revoke this at any time under Devices in <span class="code">tama settings</span>.</p>

<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request" value="${escapeHtml(v.requestId)}">
  <ul>
${rows}
  </ul>

  <label class="small" for="admin">Your admin token, to prove this is you</label>
  <input id="admin" type="password" name="admin" autocomplete="off" required>

  <div class="row">
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    <button type="submit" name="decision" value="allow">Allow</button>
  </div>
</form>
<p class="muted small" style="margin-top:1.5rem">
  Denying is the safe answer. Nothing here can read your notes until you allow it,
  and this page never shows what is in them.
</p>
</main></body></html>`;
}

/**
 * The headers this page must be served with.
 *
 * `form-action` is the one that has to be built rather than written down, and
 * getting it wrong broke the entire product silently.
 *
 * Chrome enforces `form-action` on the REDIRECT that results from a form
 * submission, not only on where the form posts. This page posts to
 * `/oauth/authorize` - same origin, allowed - and the server answers 302 to
 * `https://claude.ai/...` or `https://chatgpt.com/...`. With `form-action
 * 'self'` Chrome refuses to follow that redirect.
 *
 * Nothing reports this. The server logs a clean 302 with a valid code. The
 * browser stays put. The connector never receives a code, so it never calls the
 * token endpoint, so the failure appears to be the client silently giving up
 * for no reason - which is exactly how it looked for hours, against two
 * different vendors, while curl (which has no CSP) completed the same flow
 * perfectly.
 *
 * So the allowed callback origins are listed here. They are the same origins
 * `redirectAllowed` will accept, and no wider: a form-action entry is only a
 * permission to navigate somewhere the server was already willing to send a
 * code.
 */
export function consentHeaders(extraRedirects: string[] = []): Record<string, string> {
  const origins = new Set<string>();
  for (const uri of [...KNOWN_REDIRECTS, CHATGPT_CALLBACK_PREFIX, ...extraRedirects]) {
    try {
      origins.add(new URL(uri).origin);
    } catch { /* not a URL; redirectAllowed will refuse it anyway */ }
  }
  const formAction = ["'self'", ...[...origins].sort()].join(" ");
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    // Clickjacking an Allow button is the obvious attack on a consent screen, and
    // both of these are needed: x-frame-options for what still only reads that,
    // frame-ancestors for everything else.
    "x-frame-options": "DENY",
    "content-security-policy":
      `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
  };
}

/** The default set, for callers with no extra redirects configured. */
export const CONSENT_HEADERS: Record<string, string> = consentHeaders();
