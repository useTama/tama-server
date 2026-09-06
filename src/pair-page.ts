import { networkInterfaces } from "node:os";
import { qrSvg, escapeXml as escapeHtml } from "./qr.ts";

/**
 * The pairing page: one QR code an admin shows once per new device.
 *
 * Pairing is the one step that cannot be made hands-off, because the whole
 * point of a pairing code is that a stranger who can reach the port cannot mint
 * themselves a token. So the goal is not to remove the step, it is to make the
 * step a camera can do: no terminal, no jq, no typing a token into a phone.
 *
 * The page loads nothing. No fonts, no scripts, no images. It holds a live
 * credential, so it should not be able to talk to anything even if it wanted to.
 */

export const PAIR_PAYLOAD_VERSION = 1;

/**
 * What the QR code actually carries. A JSON object rather than a custom URL
 * scheme because iOS Shortcuts can parse this with a stock action and no app,
 * and because a scanner that "helpfully" opens URLs should find nothing to open.
 */
export function pairPayload(origin: string, code: string): string {
  return JSON.stringify({ v: PAIR_PAYLOAD_VERSION, url: origin, code });
}

const isLoopback = (host: string): boolean =>
  /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0)$/i.test(host.replace(/:\d+$/, ""));

/**
 * Addresses a phone might actually reach, best guess first.
 *
 * The admin almost always opens this page on `localhost`, which is the one
 * address that is guaranteed not to work from the phone. So the machine's own
 * LAN addresses lead, and loopback stays last as a same-machine test.
 */
export function candidateOrigins(opts: {
  host?: string | null;
  protocol?: string;
  port: number;
  interfaces?: ReturnType<typeof networkInterfaces>;
}): string[] {
  const { host, port, protocol = "http:" } = opts;
  const origins: string[] = [];
  const add = (origin: string) => { if (!origins.includes(origin)) origins.push(origin); };

  if (host && !isLoopback(host)) add(`${protocol}//${host}`);

  const nics = opts.interfaces ?? networkInterfaces();
  const lan: string[] = [];
  for (const addresses of Object.values(nics)) {
    for (const nic of addresses ?? []) {
      // IPv4 only: a link-local IPv6 address carries a zone index that does not
      // survive being retyped, and nothing here needs the extra reach.
      const family = String(nic.family);
      if (nic.internal || (family !== "IPv4" && family !== "4")) continue;
      lan.push(nic.address);
    }
  }
  // A machine with Docker and a VPN has several of these and only one of them
  // is the Wi-Fi the phone is on. 192.168/16 is the likeliest for a self-hoster,
  // and 172.16/12 is where container bridges live, so it goes last. Getting the
  // order wrong costs one tap, so this only decides what is shown first.
  for (const address of lan.map(rank).sort((a, b) => a.rank - b.rank)) {
    add(`http://${address.value}:${port}`);
  }

  add(`http://localhost:${port}`);
  // More than a handful of addresses is a wall of QR codes nobody reads, and
  // each one is a full symbol to draw.
  return origins.slice(0, MAX_ORIGINS);
}

const MAX_ORIGINS = 6;

function rank(value: string): { value: string; rank: number } {
  if (value.startsWith("192.168.")) return { value, rank: 0 };
  if (value.startsWith("10.")) return { value, rank: 1 };
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return { value, rank: 3 };
  return { value, rank: 2 };
}

const STYLE = `
:root {
  --bg: #ffffff; --fg: #1f2328; --muted: #656d76;
  --line: #d0d7de; --panel: #f6f8fa; --accent: #f04e3c;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e;
    --line: #30363d; --panel: #161b22; --accent: #f04e3c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2.5rem 1.25rem 4rem;
  background: var(--bg); color: var(--fg);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 34rem; margin: 0 auto; }
h1 { font-size: 1.35rem; margin: 0 0 .35rem; }
h1 b { color: var(--accent); }
p { margin: 0 0 1rem; }
.muted { color: var(--muted); }
.small { font-size: .875rem; }
code, .code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; }

.tabs { display: flex; flex-wrap: wrap; gap: .4rem; margin: 0 0 1rem; }
.tabs label {
  border: 1px solid var(--line); border-radius: 5px; padding: .3rem .6rem;
  font-size: .8125rem; cursor: pointer; color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
}
.pick { position: absolute; opacity: 0; pointer-events: none; }
.panel { display: none; }

figure { margin: 0; }
.qr {
  display: block; width: 100%; max-width: 17rem; height: auto;
  border: 1px solid var(--line); border-radius: 6px; background: #fff;
}
figcaption { margin-top: .5rem; }

.codebox {
  display: inline-block; margin: 1.25rem 0 .25rem; padding: .5rem .85rem;
  background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 1.5rem; letter-spacing: .12em;
}
ol { padding-left: 1.2rem; margin: 0 0 1rem; }
li { margin-bottom: .3rem; }
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0 1.25rem; }
a { color: var(--accent); }
`;

export type PairPageOptions = {
  code: string;
  /** ISO-8601, from the pairing code the server just minted. */
  expiresAt: string;
  /** At least one; the first is shown by default. */
  origins: string[];
  version: string;
};

export function renderPairPage(o: PairPageOptions): string {
  const origins = o.origins.length > 0 ? o.origins : ["http://localhost:8080"];
  const expires = new Date(o.expiresAt);
  const clock = Number.isNaN(expires.getTime())
    ? o.expiresAt
    : expires.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const picks = origins.map((_, i) => `<input class="pick" type="radio" name="origin" id="o${i}"${i === 0 ? " checked" : ""}>`).join("");

  const tabs = origins.length > 1
    ? `<div class="tabs">${origins
        .map((origin, i) => `<label for="o${i}">${escapeHtml(origin.replace(/^https?:\/\//, ""))}</label>`)
        .join("")}</div>`
    : "";

  const panels = origins
    .map((origin, i) => {
      const svg = qrSvg(pairPayload(origin, o.code), { title: `Pairing code ${o.code} for ${origin}` })
        .replace("<svg ", `<svg class="qr" `);
      return `<figure class="panel p${i}">${svg}<figcaption class="small muted">Points the device at <span class="code">${escapeHtml(origin)}</span></figcaption></figure>`;
    })
    .join("");

  // Only CSS switches between addresses, so the page can run with scripting
  // switched off entirely and still be one tap per address.
  const panelRules = origins
    .map((_, i) => `#o${i}:checked ~ .p${i} { display: block; }
#o${i}:checked ~ .tabs label[for="o${i}"] { color: var(--fg); border-color: var(--accent); }`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Pair a device — Tama</title>
<style>${STYLE}${panelRules}</style>
<main>
  <h1><b>Tama</b> · pair a device</h1>
  <p class="muted small">Scan this with the Tama Setup shortcut. Valid until ${escapeHtml(clock)}, once, for one device.</p>

  ${picks}
  ${tabs}
  ${panels}

  <div class="codebox">${escapeHtml(o.code)}</div>
  <p class="small muted">Type this instead if the camera will not cooperate.</p>

  <hr>
  <ol class="small">
    <li>On the phone, run the <b>Tama Setup</b> shortcut.</li>
    <li>Point the camera at the code above.</li>
    <li>Name the device when asked. That name is what shows up on every note it captures.</li>
  </ol>
  <p class="small muted">Reload this page for a fresh code. Codes expire after ten minutes and each one pairs a single device.</p>
  <p class="small muted">tama-server ${escapeHtml(o.version)}</p>
</main>
`;
}
