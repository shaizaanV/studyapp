'use strict';

/**
 * Generates build/icon.ico from scratch using only Node's standard library.
 *
 * Keeping the icon as code rather than a checked-in binary means the repo
 * carries no opaque blob, the mark stays in sync with the app's accent colour,
 * and anyone can regenerate it with `npm run icon`.
 *
 * The mark: a neon-lime timer arc on a near-black rounded square.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** Icon sizes Windows picks between for the taskbar, Start menu and Explorer. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** Samples per axis for antialiasing. 3 means 9 samples per pixel. */
const SUPERSAMPLE = 4;

const BG = [0x11, 0x14, 0x18];
const ACCENT = [0xc6, 0xff, 0x3d];

/** Degrees of the arc, leaving a gap so it reads as a timer rather than a ring. */
const ARC_SWEEP = 280;

// ------------------------------------------------------------------ PNG codec

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 8-bit RGBA PNG, one filter-none scanline per row. */
function encodePng(size, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// -------------------------------------------------------------------- drawing

/** Rounded-square mask, used to keep the corners transparent. */
function insideRoundedSquare(x, y, size, radius) {
  const dx = Math.min(x, size - x);
  const dy = Math.min(y, size - y);
  if (dx < 0 || dy < 0) return false;
  if (dx >= radius || dy >= radius) return true;
  return Math.hypot(radius - dx, radius - dy) <= radius;
}

/** Angle in degrees, zero at twelve o'clock, increasing clockwise. */
function angleFromTop(dx, dy) {
  const degrees = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);

  const center = size / 2;
  const radiusOuter = size * 0.355;
  const radiusInner = size * 0.25;
  const cornerRadius = size * 0.22;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let squareHits = 0;
      let arcHits = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const py = y + (sy + 0.5) / SUPERSAMPLE;

          if (!insideRoundedSquare(px, py, size, cornerRadius)) continue;
          squareHits++;

          const dx = px - center;
          const dy = py - center;
          const distance = Math.hypot(dx, dy);

          if (
            distance >= radiusInner &&
            distance <= radiusOuter &&
            angleFromTop(dx, dy) <= ARC_SWEEP
          ) {
            arcHits++;
          }
        }
      }

      const offset = (y * size + x) * 4;
      if (squareHits === 0) continue; // stays fully transparent

      // The arc is composited over the background within the covered area, so
      // coverage of the square drives alpha and coverage of the arc drives hue.
      const arcShare = arcHits / squareHits;
      for (let channel = 0; channel < 3; channel++) {
        rgba[offset + channel] = Math.round(
          BG[channel] * (1 - arcShare) + ACCENT[channel] * arcShare
        );
      }
      rgba[offset + 3] = Math.round((squareHits / samples) * 255);
    }
  }

  return rgba;
}

// ---------------------------------------------------------------- ICO container

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = index * 16;
    // A 256px image is recorded as 0; the field is a single byte.
    directory[entry] = image.size >= 256 ? 0 : image.size;
    directory[entry + 1] = image.size >= 256 ? 0 : image.size;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

// ------------------------------------------------------------------------ main

function main() {
  const images = SIZES.map((size) => ({
    size,
    png: encodePng(size, drawIcon(size)),
  }));

  const outputDir = path.join(__dirname, '..', 'build');
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'icon.ico');
  const ico = buildIco(images);
  fs.writeFileSync(outputPath, ico);

  console.log(
    `[flowcus] wrote ${path.relative(path.join(__dirname, '..'), outputPath)} ` +
      `(${SIZES.join(', ')} px, ${(ico.length / 1024).toFixed(1)} KB)`
  );
}

main();
