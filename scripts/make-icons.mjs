#!/usr/bin/env node
// Generates the extension icons.
//
// Drawn in code rather than checked in as opaque binaries: the mark is four
// numbers, and at 16px anything more detailed turns to mud anyway.
//
// Magpie colouring — a dark ground, a white swell, and one red dot for the shiny
// thing it took.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Anona's own: the ink and plate of the dashboard, and the brand red that its
// globals.css calls "the brand red itself".
const INK = [0x12, 0x17, 0x1a];
const WHITE = [0xfb, 0xfb, 0xf9];
const ACCENT = [0xb0, 0x23, 0x24];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  // Each scanline is prefixed with its filter type; 0 means none.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded square, in normalised units. */
function roundedSquare(x, y, radius) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return Math.hypot(dx, dy) - radius;
}

const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  // Supersample, so the curves do not stairstep at 16px.
  const SS = 4;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;

          if (roundedSquare(u, v, 0.23) > 0) continue;      // outside the tile

          let colour = INK;
          if (circle(u, v, 0.20, 0.95, 0.50) < 0) colour = WHITE;
          if (circle(u, v, 0.68, 0.32, 0.145) < 0) colour = ACCENT;

          r += colour[0]; g += colour[1]; b += colour[2]; a += 255;
        }
      }

      const samples = SS * SS;
      const i = (y * size + x) * 4;
      // Premultiplied accumulation: divide colour by covered samples, not all.
      const covered = a / 255 || 1;
      px[i] = Math.round(r / covered);
      px[i + 1] = Math.round(g / covered);
      px[i + 2] = Math.round(b / covered);
      px[i + 3] = Math.round(a / samples);
    }
  }
  return px;
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), '../icons');
mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `${size}.png`), png(size, draw(size)));
  console.log(`icons/${size}.png`);
}
