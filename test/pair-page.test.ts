import { test, expect } from "bun:test";
import { candidateOrigins, pairPayload, renderPairPage, PAIR_PAYLOAD_VERSION } from "../src/pair-page.ts";

const nics = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [
    { address: "fe80::1", family: "IPv6", internal: false },
    { address: "192.168.1.20", family: "IPv4", internal: false },
  ],
  utun3: [{ address: "10.8.0.4", family: "IPv4", internal: false }],
} as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

// ---- which address goes in the code --------------------------------------

test("localhost is offered last, because it is the one address the phone cannot reach", () => {
  const origins = candidateOrigins({ host: "localhost:8080", port: 8080, interfaces: nics });
  expect(origins[0]).toBe("http://192.168.1.20:8080");
  expect(origins).toContain("http://10.8.0.4:8080");
  expect(origins.at(-1)).toBe("http://localhost:8080");
});

test("an address the admin actually browsed to leads, since it is known to work", () => {
  const origins = candidateOrigins({ host: "tama.local:8080", protocol: "http:", port: 8080, interfaces: nics });
  expect(origins[0]).toBe("http://tama.local:8080");
});

test("a loopback host header is not treated as a working address", () => {
  for (const host of ["127.0.0.1:8080", "localhost:8080", "0.0.0.0:8080", "[::1]:8080"]) {
    expect(candidateOrigins({ host, port: 8080, interfaces: nics })[0]).toBe("http://192.168.1.20:8080");
  }
});

test("internal and IPv6 interfaces are skipped, and duplicates collapse", () => {
  const origins = candidateOrigins({ host: "192.168.1.20:8080", port: 8080, interfaces: nics });
  expect(origins.filter((o) => o === "http://192.168.1.20:8080")).toHaveLength(1);
  expect(origins.some((o) => o.includes("fe80"))).toBe(false);
  expect(origins.some((o) => o.includes("127.0.0.1"))).toBe(false);
});

test("the likeliest LAN goes first: Wi-Fi over VPN, and container bridges last", () => {
  const busy = {
    en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
    utun3: [{ address: "10.8.0.4", family: "IPv4", internal: false }],
    bridge0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    en5: [{ address: "169.254.7.7", family: "IPv4", internal: false }],
  } as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

  expect(candidateOrigins({ host: "localhost:8080", port: 8080, interfaces: busy })).toEqual([
    "http://192.168.1.20:8080",
    "http://10.8.0.4:8080",
    "http://169.254.7.7:8080",
    "http://172.17.0.1:8080",
    "http://localhost:8080",
  ]);
});

test("a wall of interfaces is trimmed rather than drawn as a wall of QR codes", () => {
  const many = Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [`en${i}`, [{ address: `10.0.0.${i}`, family: "IPv4", internal: false }]]),
  ) as unknown as ReturnType<typeof import("node:os").networkInterfaces>;

  const origins = candidateOrigins({ host: "localhost:8080", port: 8080, interfaces: many });
  expect(origins).toHaveLength(6);
  expect(origins[0]).toBe("http://10.0.0.0:8080");
});

test("a machine with no LAN address still gets a usable page", () => {
  const origins = candidateOrigins({ host: "localhost:8080", port: 8080, interfaces: {} });
  expect(origins).toEqual(["http://localhost:8080"]);
});

// ---- the payload the shortcut parses -------------------------------------

test("the payload is JSON a stock Shortcuts action can read", () => {
  const parsed = JSON.parse(pairPayload("http://192.168.1.20:8080", "807390"));
  expect(parsed).toEqual({ v: PAIR_PAYLOAD_VERSION, url: "http://192.168.1.20:8080", code: "807390" });
});

test("the payload carries no admin token, only the single-use code", () => {
  const payload = pairPayload("http://192.168.1.20:8080", "807390");
  expect(payload).not.toMatch(/token/i);
});

// ---- the page ------------------------------------------------------------

const page = (over: Partial<Parameters<typeof renderPairPage>[0]> = {}) =>
  renderPairPage({
    code: "807390",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    origins: ["http://192.168.1.20:8080", "http://localhost:8080"],
    version: "0.1.0",
    ...over,
  });

test("the page shows the code in text as well as in the QR", () => {
  expect(page()).toContain(">807390<");
});

test("one QR per address, the first one showing", () => {
  const html = page();
  expect(html.match(/<svg /g)).toHaveLength(2);
  expect(html).toContain(`id="o0" checked`);
  expect(html).toContain("#o1:checked ~ .p1 { display: block; }");
});

test("the page loads nothing from anywhere", () => {
  const html = page();
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/https?:\/\/(?!192\.168|localhost|www\.w3\.org)/);
  expect(html).not.toMatch(/<img|<link|@import|url\(/i);
});

test("an address is escaped rather than able to close a tag", () => {
  const html = page({ origins: [`http://x"><script>alert(1)</script>`] });
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});

test("the page still renders if the expiry timestamp is unparseable", () => {
  expect(page({ expiresAt: "soon" })).toContain("soon");
});
