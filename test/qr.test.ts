import { test, expect } from "bun:test";
import { encodeQr, ecCodewords, capacity, versionFor, qrSvg, MAX_VERSION } from "../src/qr.ts";

const render = (m: { dark: boolean[][] }) => m.dark.map((r) => r.map((d) => (d ? "#" : ".")).join(""));

test("reed-solomon matches the worked example in ISO 18004 annex I", () => {
  // The spec's 1-M symbol for "01234567": these are its data codewords, and
  // the ten error codewords printed beside them.
  const data = Uint8Array.from([
    0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11,
    0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
  ]);
  expect([...ecCodewords(data, 10)]).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
});

test("capacity rises with version and picks the smallest that fits", () => {
  expect(capacity(1)).toBe(14);
  expect(capacity(2)).toBe(26);
  expect(capacity(MAX_VERSION)).toBe(213);

  expect(versionFor(14)).toBe(1);
  expect(versionFor(15)).toBe(2);
  expect(versionFor(213)).toBe(MAX_VERSION);
  expect(versionFor(214)).toBeNull();
});

test("a payload larger than the biggest version is refused, not silently truncated", () => {
  expect(() => encodeQr("x".repeat(214))).toThrow(/version-10 QR code holds/);
});

test("size follows the version formula and grows with the payload", () => {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const m = encodeQr("x".repeat(capacity(v)));
    expect(m.version).toBe(v);
    expect(m.size).toBe(v * 4 + 17);
    expect(m.dark.length).toBe(m.size);
    expect(m.dark.every((row) => row.length === m.size)).toBe(true);
  }
});

test("the three finder patterns and both timing patterns are in place", () => {
  const m = encodeQr("http://127.0.0.1:8080");
  const rows = render(m);
  const last = m.size - 1;

  for (const [top, left] of [[0, 0], [0, m.size - 7], [m.size - 7, 0]] as const) {
    expect(rows[top]!.slice(left, left + 7)).toBe("#######");
    expect(rows[top + 3]!.slice(left, left + 7)).toBe("#.###.#");
    expect(rows[top + 6]!.slice(left, left + 7)).toBe("#######");
  }

  for (let i = 8; i < m.size - 8; i++) {
    expect(m.dark[6]![i]).toBe(i % 2 === 0);
    expect(m.dark[i]![6]).toBe(i % 2 === 0);
  }

  // The module below the bottom-left finder is dark in every conforming symbol.
  expect(m.dark[m.size - 8]![8]).toBe(true);
  expect(rows[last]!.slice(0, 7)).toBe("#######");
});

test("a known payload encodes to a known matrix", () => {
  // Locked against a matrix cross-checked module for module with an independent
  // encoder, so a regression here is a real change in output and not a reformat.
  const m = encodeQr("http://192.168.1.20:8080");
  expect(m.version).toBe(2);
  expect(m.mask).toBe(2);
  expect(render(m)).toEqual([
    "#######..###..#...#######",
    "#.....#..#...#.#..#.....#",
    "#.###.#.##......#.#.###.#",
    "#.###.#.#....#....#.###.#",
    "#.###.#.#.#.#.#...#.###.#",
    "#.....#.#..##..##.#.....#",
    "#######.#.#.#.#.#.#######",
    "........##.#...#.........",
    "#.#####...##.#.##.#####..",
    "..#.##..#.##.##..#.....#.",
    "##...####.##.#.#..##.#.##",
    "#####..##.#.....#...#...#",
    "##....##.##..#....###.###",
    "#...##...##.###......#.#.",
    "#..#..#.##.....#.#.#.#.##",
    "#.##.#....#.#..#.....#..#",
    "#...#.#.#...##..#####.#..",
    "........##....#.#...###..",
    "#######..####...#.#.#####",
    "#.....#.####...##...##..#",
    "#.###.#.######.########..",
    "#.###.#.#.#.#####.###.###",
    "#.###.#.#...#....#....#.#",
    "#.....#...#.#...#.####..#",
    "#######.#....#.#.########",
  ]);
});

test("payloads are encoded as UTF-8, so non-ASCII text survives", () => {
  const text = "café ünïcode ✓ 日本語";
  const bytes = new TextEncoder().encode(text).length;
  expect(bytes).toBeGreaterThan(text.length);
  expect(encodeQr(text).version).toBe(versionFor(bytes)!);
});

test("svg carries a quiet zone and scales with the viewBox, not a pixel size", () => {
  const svg = qrSvg("http://192.168.1.20:8080", { title: "pair" });
  expect(svg).toContain(`viewBox="0 0 33 33"`); // 25 modules plus 4 either side
  expect(svg).toContain("shape-rendering=\"crispEdges\"");
  expect(svg).toContain("<title>pair</title>");
  expect(svg).toMatch(/<path fill="#000000" d="M\d/);
  // No pixel size on the root element: the page decides how big it renders.
  expect(svg.slice(0, svg.indexOf(">"))).not.toContain("width=");
});

test("svg escapes a title rather than letting it close the tag", () => {
  const svg = qrSvg("x", { title: `</title><script>alert(1)</script>` });
  expect(svg).not.toContain("<script>");
  expect(svg).toContain("&lt;/title&gt;");
});
