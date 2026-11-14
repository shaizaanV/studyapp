'use strict';

/**
 * A small QR Code encoder: byte mode, error correction level M, versions 1-6
 * (up to 106 bytes), which is far more than a flowcus://join/CODE link needs.
 * Dependency-free so the renderer can load it as a plain <script>, and it
 * returns a boolean matrix so the caller can draw it as SVG rects (the page's
 * CSP forbids inline styles and remote images).
 *
 * Follows ISO/IEC 18004: Reed-Solomon over GF(256) with 0x11D, finder, timing
 * and alignment patterns, zig-zag data placement, and the lowest-penalty of the
 * eight masks.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Level M: [ecc codewords per block, blocks] and alignment pattern centres, per version 1-6.
  const VERSIONS = [
    null,
    { total: 26, ecc: 10, blocks: 1, align: [] },
    { total: 44, ecc: 16, blocks: 1, align: [6, 18] },
    { total: 70, ecc: 26, blocks: 1, align: [6, 22] },
    { total: 100, ecc: 18, blocks: 2, align: [6, 26] },
    { total: 134, ecc: 24, blocks: 2, align: [6, 30] },
    { total: 172, ecc: 16, blocks: 4, align: [6, 34] },
  ];
  const MAX_VERSION = 6;

  const dataCodewords = (v) => VERSIONS[v].total - VERSIONS[v].ecc * VERSIONS[v].blocks;

  // ----------------------------------------------------------- GF(256) maths
  const EXP = new Array(512);
  const LOG = new Array(256);
  (function initField() {
    let x = 1;
    for (let i = 0; i < 255; i += 1) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
  })();

  const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function generatorPoly(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i += 1) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j += 1) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function reedSolomon(data, degree) {
    const gen = generatorPoly(degree);
    const result = new Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ result[0];
      result.shift();
      result.push(0);
      for (let i = 0; i < degree; i += 1) result[i] ^= gfMul(gen[i + 1], factor);
    }
    return result;
  }

  // ------------------------------------------------------------- bit buffer
  function utf8(text) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(text));
    return Array.from(Buffer.from(text, 'utf8'));
  }

  function buildCodewords(bytes, version) {
    const capacityBits = dataCodewords(version) * 8;
    const bits = [];
    const push = (value, length) => {
      for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    };
    push(0b0100, 4); // byte mode
    push(bytes.length, 8); // character count: 8 bits for versions 1-9
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, capacityBits - bits.length)); // terminator
    while (bits.length % 8 !== 0) bits.push(0);
    const words = [];
    for (let i = 0; i < bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; words.length < dataCodewords(version); pad ^= 0xec ^ 0x11) words.push(pad);
    return words;
  }

  /** Splits data into blocks, appends each block's ECC, and interleaves. */
  function interleave(data, version) {
    const { ecc, blocks } = VERSIONS[version];
    const per = data.length / blocks; // levels M for versions 1-6 split evenly
    const dataBlocks = [];
    for (let i = 0; i < blocks; i += 1) dataBlocks.push(data.slice(i * per, (i + 1) * per));
    const eccBlocks = dataBlocks.map((block) => reedSolomon(block, ecc));
    const out = [];
    for (let i = 0; i < per; i += 1) for (const block of dataBlocks) out.push(block[i]);
    for (let i = 0; i < ecc; i += 1) for (const block of eccBlocks) out.push(block[i]);
    return out;
  }

  // ----------------------------------------------------------------- matrix
  function makeMatrix(version) {
    const size = 17 + version * 4;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => {
      modules[y][x] = dark;
      reserved[y][x] = true;
    };

    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);

    for (let i = 8; i < size - 8; i += 1) {
      set(i, 6, i % 2 === 0);
      set(6, i, i % 2 === 0);
    }

    const centres = VERSIONS[version].align;
    for (const cy of centres) {
      for (const cx of centres) {
        const onFinder = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
        if (onFinder) continue;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    // Reserve the format areas and the always-dark module.
    for (let i = 0; i < 9; i += 1) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
    for (let i = 0; i < 8; i += 1) {
      reserved[8][size - 1 - i] = true;
      reserved[size - 1 - i][8] = true;
    }
    set(8, size - 8, true);
    return { size, modules, reserved };
  }

  function placeData(matrix, codewords) {
    const { size, modules, reserved } = matrix;
    const bits = [];
    for (const word of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((word >>> i) & 1);
    let index = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step += 1) {
        const y = upward ? size - 1 - step : step;
        for (let dx = 0; dx < 2; dx += 1) {
          const x = right - dx;
          if (reserved[y][x]) continue;
          modules[y][x] = index < bits.length ? bits[index] === 1 : false;
          index += 1;
        }
      }
      upward = !upward;
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => ((((x * y) % 2) + ((x * y) % 3)) % 2) === 0,
    (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
  ];

  /** Level M is the format-bit pattern 00. */
  function formatBits(mask) {
    const data = (0b00 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function drawFormat(matrix, mask) {
    const { size, modules } = matrix;
    const bits = formatBits(mask);
    const bit = (i) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i += 1) modules[i][8] = bit(i);
    modules[7][8] = bit(6);
    modules[8][8] = bit(7);
    modules[8][7] = bit(8);
    for (let i = 9; i < 15; i += 1) modules[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = bit(i);
    modules[size - 8][8] = true;
  }

  function penalty(modules) {
    const size = modules.length;
    let score = 0;
    const runScore = (line) => {
      let total = 0;
      let run = 1;
      for (let i = 1; i < line.length; i += 1) {
        if (line[i] === line[i - 1]) {
          run += 1;
        } else {
          if (run >= 5) total += run - 2;
          run = 1;
        }
      }
      if (run >= 5) total += run - 2;
      return total;
    };
    for (let i = 0; i < size; i += 1) {
      score += runScore(modules[i]);
      score += runScore(modules.map((row) => row[i]));
    }
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const v = modules[y][x];
        if (v === modules[y][x + 1] && v === modules[y + 1][x] && v === modules[y + 1][x + 1]) score += 3;
      }
    }
    const pattern = [true, false, true, true, true, false, true, false, false, false, false];
    const matches = (line, at, p) => p.every((v, k) => line[at + k] === v);
    const reversed = [...pattern].reverse();
    for (let i = 0; i < size; i += 1) {
      const col = modules.map((row) => row[i]);
      for (let at = 0; at + 11 <= size; at += 1) {
        if (matches(modules[i], at, pattern) || matches(modules[i], at, reversed)) score += 40;
        if (matches(col, at, pattern) || matches(col, at, reversed)) score += 40;
      }
    }
    const dark = modules.reduce((n, row) => n + row.filter(Boolean).length, 0);
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
    return score;
  }

  /**
   * Encodes `text`. Returns {size, modules} where modules[y][x] is true for a
   * dark square; throws if the text does not fit in version 6.
   */
  function encode(text) {
    const bytes = utf8(String(text));
    let version = 1;
    while (version <= MAX_VERSION && 4 + 8 + bytes.length * 8 > dataCodewords(version) * 8) version += 1;
    if (version > MAX_VERSION) throw new Error('QR: text too long');

    const codewords = interleave(buildCodewords(bytes, version), version);
    const base = makeMatrix(version);
    placeData(base, codewords);

    let best = null;
    for (let mask = 0; mask < 8; mask += 1) {
      const candidate = {
        size: base.size,
        reserved: base.reserved,
        modules: base.modules.map((row, y) => row.map((v, x) => (base.reserved[y][x] ? v : v !== MASKS[mask](x, y)))),
      };
      drawFormat(candidate, mask);
      const score = penalty(candidate.modules);
      if (!best || score < best.score) best = { score, modules: candidate.modules };
    }
    return { size: base.size, modules: best.modules };
  }

  /**
   * Reads a matrix back: format bits, unmasking, de-interleaving, Reed-Solomon
   * syndrome check, and the byte-mode payload. Used by the tests as a
   * round-trip check on encode(); returns {text, mask, version}.
   */
  function decode({ size, modules }) {
    const version = (size - 17) / 4;
    const base = makeMatrix(version);
    const bitAt = (x, y) => (modules[y][x] ? 1 : 0);
    let format = 0;
    for (let i = 0; i <= 5; i += 1) format |= bitAt(8, i) << i;
    format |= bitAt(8, 7) << 6;
    format |= bitAt(8, 8) << 7;
    format |= bitAt(7, 8) << 8;
    for (let i = 9; i < 15; i += 1) format |= bitAt(14 - i, 8) << i;
    let mask = -1;
    for (let m = 0; m < 8; m += 1) if (formatBits(m) === format) mask = m;
    if (mask < 0) throw new Error('QR: bad format bits');

    const bits = [];
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step += 1) {
        const y = upward ? size - 1 - step : step;
        for (let dx = 0; dx < 2; dx += 1) {
          const x = right - dx;
          if (base.reserved[y][x]) continue;
          bits.push(modules[y][x] !== MASKS[mask](x, y) ? 1 : 0);
        }
      }
      upward = !upward;
    }
    const { total, ecc, blocks } = VERSIONS[version];
    const words = [];
    for (let i = 0; i < total; i += 1) words.push(parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2));
    const per = (total - ecc * blocks) / blocks;
    const dataBlocks = Array.from({ length: blocks }, () => []);
    const eccBlocks = Array.from({ length: blocks }, () => []);
    let at = 0;
    for (let i = 0; i < per; i += 1) for (let b = 0; b < blocks; b += 1) dataBlocks[b].push(words[at++]);
    for (let i = 0; i < ecc; i += 1) for (let b = 0; b < blocks; b += 1) eccBlocks[b].push(words[at++]);
    for (let b = 0; b < blocks; b += 1) {
      const expected = reedSolomon(dataBlocks[b], ecc);
      if (expected.some((v, i) => v !== eccBlocks[b][i])) throw new Error('QR: Reed-Solomon mismatch');
    }
    const data = dataBlocks.flat();
    const stream = data.map((w) => w.toString(2).padStart(8, '0')).join('');
    if (stream.slice(0, 4) !== '0100') throw new Error('QR: not byte mode');
    const length = parseInt(stream.slice(4, 12), 2);
    const out = [];
    for (let i = 0; i < length; i += 1) out.push(parseInt(stream.slice(12 + i * 8, 20 + i * 8), 2));
    return { text: Buffer.from(out).toString('utf8'), mask, version };
  }

  return { encode, decode };
});
