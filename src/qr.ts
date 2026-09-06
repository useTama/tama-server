/**
 * A QR encoder: byte mode, error correction level M, versions 1-10.
 *
 * Written out rather than pulled in because the only thing that needs a QR code
 * is one HTML page, and a capture path that promises to stay local should not
 * grow a dependency tree to draw a square. Versions 1-10 carry 213 bytes at
 * level M, which is an order of magnitude more than a pairing payload needs.
 *
 * Level M (~15% recoverable) is the usual choice for a screen: the code is
 * clean and well lit, so the higher levels only buy a denser grid.
 */

export type QrMatrix = {
  /** Modules per side, excluding the quiet zone. */
  size: number;
  /** `dark[row][col]`. Row 0 is the top edge. */
  dark: boolean[][];
  version: number;
  mask: number;
};

// ---------------------------------------------------------------- GF(256)

// QR arithmetic lives in GF(256) with the primitive polynomial 0x11d.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

const mul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);

/** g(x) = (x - a^0)(x - a^1)...(x - a^(degree-1)), coefficients highest power first. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= mul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder: the error correction codewords for one block. */
export function ecCodewords(data: Uint8Array, count: number): Uint8Array {
  const gen = generatorPoly(count);
  const work = new Uint8Array(data.length + count);
  work.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = work[i]!;
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) work[i + j]! ^= mul(gen[j]!, factor);
  }
  return work.slice(data.length);
}

// ---------------------------------------------------------------- tables

/** Level M only: error codewords per block, then [blocks, data codewords] per group. */
const SPECS: Record<number, { ec: number; g1: [number, number]; g2?: [number, number] }> = {
  1: { ec: 10, g1: [1, 16] },
  2: { ec: 16, g1: [1, 28] },
  3: { ec: 26, g1: [1, 44] },
  4: { ec: 18, g1: [2, 32] },
  5: { ec: 24, g1: [2, 43] },
  6: { ec: 16, g1: [4, 27] },
  7: { ec: 18, g1: [4, 31] },
  8: { ec: 22, g1: [2, 38], g2: [2, 39] },
  9: { ec: 22, g1: [3, 36], g2: [2, 37] },
  10: { ec: 26, g1: [4, 43], g2: [1, 44] },
};

const ALIGNMENT: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

export const MAX_VERSION = 10;

const dataCodewords = (version: number): number => {
  const s = SPECS[version]!;
  return s.g1[0] * s.g1[1] + (s.g2 ? s.g2[0] * s.g2[1] : 0);
};

/** Byte-mode payload capacity, after the mode nibble and the length field. */
export function capacity(version: number): number {
  const header = 4 + (version >= 10 ? 16 : 8);
  return dataCodewords(version) - Math.ceil(header / 8);
}

// ---------------------------------------------------------------- bitstream

function codewordsFor(bytes: Uint8Array, version: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };

  push(0b0100, 4);                              // byte mode
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(dataCodewords(version));
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
    out[i / 8] = byte;
  }
  // 0xEC / 0x11 alternating is the padding the spec names, and a decoder stops
  // at the terminator, so this is never read as content.
  for (let i = bits.length / 8, pad = 0; i < out.length; i++, pad++) {
    out[i] = pad % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/**
 * Split into blocks, error-correct each, then interleave. Interleaving is what
 * makes a scratch across the code hit one codeword of every block instead of
 * destroying one block outright.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const spec = SPECS[version]!;
  const groups: [number, number][] = spec.g2 ? [spec.g1, spec.g2] : [spec.g1];

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [blocks, perBlock] of groups) {
    for (let i = 0; i < blocks; i++) {
      const block = data.slice(offset, offset + perBlock);
      offset += perBlock;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, spec.ec));
    }
  }

  const out: number[] = [];
  const widest = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < widest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- matrix

type Canvas = { size: number; dark: boolean[][]; fixed: boolean[][] };

function blankCanvas(version: number): Canvas {
  const size = version * 4 + 17;
  return {
    size,
    dark: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    fixed: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function set(c: Canvas, row: number, col: number, dark: boolean): void {
  c.dark[row]![col] = dark;
  c.fixed[row]![col] = true;
}

function drawFunctionPatterns(c: Canvas, version: number): void {
  const { size } = c;

  // Finder patterns and their separators. The separator is drawn as part of the
  // same pass so the light ring is reserved, not left open to data.
  for (const [top, left] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const row = top + dr;
        const col = left + dc;
        if (row < 0 || row >= size || col < 0 || col >= size) continue;
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(c, row, col, inside && (ring || core));
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    set(c, 6, i, i % 2 === 0);
    set(c, i, 6, i % 2 === 0);
  }

  const centres = ALIGNMENT[version]!;
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(c, row + dr, col + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format strips. Their contents are written after masking.
  for (let i = 0; i <= 8; i++) {
    if (!c.fixed[8]![i]) set(c, 8, i, false);
    if (!c.fixed[i]![8]) set(c, i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    if (!c.fixed[8]![size - 1 - i]) set(c, 8, size - 1 - i, false);
    if (!c.fixed[size - 1 - i]![8]) set(c, size - 1 - i, 8, false);
  }
  set(c, size - 8, 8, true); // the always-dark module

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(c, size - 11 + j, i, false);
        set(c, i, size - 11 + j, false);
      }
    }
  }
}

/** Zigzag up and down two-module columns, right to left, skipping the timing column. */
function placeCodewords(c: Canvas, codewords: Uint8Array): void {
  const { size } = c;
  const dataBits = codewords.length * 8;
  let bit = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (const col of [right, right - 1]) {
        if (c.fixed[row]![col]) continue;
        // Past the last codeword come this version's remainder bits, which are
        // always zero and exist only to fill the grid out.
        c.dark[row]![col] = bit < dataBits && ((codewords[bit >> 3]! >> (7 - (bit % 8))) & 1) === 1;
        bit++;
      }
    }
    upward = !upward;
  }
}

const MASKS: Array<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(c: Canvas, mask: number): void {
  const f = MASKS[mask]!;
  for (let row = 0; row < c.size; row++) {
    for (let col = 0; col < c.size; col++) {
      if (!c.fixed[row]![col] && f(row, col)) c.dark[row]![col] = !c.dark[row]![col];
    }
  }
}

function drawFormatBits(c: Canvas, mask: number): void {
  const { size } = c;
  const data = 0b00_000 | mask; // level M is 0b00
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const at = (i: number) => ((bits >>> i) & 1) === 1;

  // Both copies are read starting at bit 14. The first runs left to right along
  // row 8 and then up column 8; the second starts at the bottom-left corner and
  // runs up, then continues left to right along row 8 on the far side.
  for (let i = 0; i <= 5; i++) set(c, i, 8, at(i));
  set(c, 7, 8, at(6));
  set(c, 8, 8, at(7));
  set(c, 8, 7, at(8));
  for (let i = 9; i < 15; i++) set(c, 8, 14 - i, at(i));

  for (let i = 0; i < 7; i++) set(c, size - 1 - i, 8, at(14 - i));
  for (let i = 0; i < 8; i++) set(c, 8, size - 8 + i, at(7 - i));
  set(c, size - 8, 8, true);
}

function drawVersionBits(c: Canvas, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const on = ((bits >>> i) & 1) === 1;
    const far = c.size - 11 + (i % 3);
    const near = Math.floor(i / 3);
    set(c, near, far, on);
    set(c, far, near, on);
  }
}

/** The spec's four penalty rules. Lower is easier for a scanner to lock onto. */
function penalty(c: Canvas): number {
  const { size, dark } = c;
  let score = 0;

  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i < size; i++) {
      if (get(i) === get(i - 1)) {
        run++;
        if (run === 5) score += 3;
        else if (run > 5) score += 1;
      } else run = 1;
    }
  };
  for (let r = 0; r < size; r++) line((i) => dark[r]![i]!);
  for (let col = 0; col < size; col++) line((i) => dark[i]![col]!);

  for (let r = 0; r < size - 1; r++) {
    for (let col = 0; col < size - 1; col++) {
      const v = dark[r]![col]!;
      if (v === dark[r]![col + 1] && v === dark[r + 1]![col] && v === dark[r + 1]![col + 1]) score += 3;
    }
  }

  // A finder-like run anywhere else is the pattern most likely to confuse a
  // scanner into misreading where the symbol starts.
  const FINDER = [true, false, true, true, true, false, true, false, false, false, false];
  const looksLikeFinder = (get: (i: number) => boolean, start: number, reversed: boolean) => {
    for (let i = 0; i < FINDER.length; i++) {
      if (get(start + i) !== FINDER[reversed ? FINDER.length - 1 - i : i]) return false;
    }
    return true;
  };
  const scanFinders = (get: (i: number) => boolean) => {
    for (let i = 0; i + FINDER.length <= size; i++) {
      if (looksLikeFinder(get, i, false) || looksLikeFinder(get, i, true)) score += 40;
    }
  };
  for (let r = 0; r < size; r++) scanFinders((i) => dark[r]![i]!);
  for (let col = 0; col < size; col++) scanFinders((i) => dark[i]![col]!);

  let darkCount = 0;
  for (let r = 0; r < size; r++) for (let col = 0; col < size; col++) if (dark[r]![col]) darkCount++;
  const total = size * size;
  score += (Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1) * 10;

  return score;
}

// ---------------------------------------------------------------- public

/** Smallest level-M version that holds `bytes`, or null if nothing here does. */
export function versionFor(byteLength: number): number | null {
  for (let v = 1; v <= MAX_VERSION; v++) if (capacity(v) >= byteLength) return v;
  return null;
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = versionFor(bytes.length);
  if (version === null) {
    throw new Error(`${bytes.length} bytes is more than a version-${MAX_VERSION} QR code holds (${capacity(MAX_VERSION)})`);
  }

  const codewords = interleave(codewordsFor(bytes, version), version);

  let best: Canvas | null = null;
  let bestMask = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const c = blankCanvas(version);
    drawFunctionPatterns(c, version);
    placeCodewords(c, codewords);
    applyMask(c, mask);
    drawFormatBits(c, mask);
    drawVersionBits(c, version);
    const score = penalty(c);
    if (score < bestScore) {
      bestScore = score;
      best = c;
      bestMask = mask;
    }
  }

  return { size: best!.size, dark: best!.dark, version, mask: bestMask };
}

/**
 * An SVG of the code as one `<path>`. Vector because the page it lands on may be
 * printed, zoomed, or shown on a display whose pixel ratio we cannot know.
 */
export function qrSvg(text: string, opts: { quietZone?: number; title?: string } = {}): string {
  const { size, dark } = encodeQr(text);
  const quiet = opts.quietZone ?? 4;
  const side = size + quiet * 2;

  const parts: string[] = [];
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!dark[row]![col]) { col++; continue; }
      let run = 1;
      while (col + run < size && dark[row]![col + run]) run++;
      parts.push(`M${col + quiet} ${row + quiet}h${run}v1h-${run}z`);
      col += run;
    }
  }

  const label = opts.title ? `<title>${escapeXml(opts.title)}</title>` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${escapeXml(opts.title ?? "QR code")}">` +
    `${label}<rect width="${side}" height="${side}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${parts.join("")}"/></svg>`
  );
}

export function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
