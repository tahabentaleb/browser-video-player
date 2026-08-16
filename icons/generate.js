/**
 * Generates icon_16/32/48/128.png with no dependencies (Node zlib only).
 * Usage: node icons/generate.js — then add the "icons" snippet from README
 * to manifest.json. (Chrome requires PNG icons; shipping none is valid and
 * Chrome falls back to default icons.)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function inTriangle(px, py, a, b, c) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const d1 = s([px, py], a, b), d2 = s([px, py], b, c), d3 = s([px, py], c, a);
  return !(((d1 < 0) || (d2 < 0) || (d3 < 0)) && ((d1 > 0) || (d2 > 0) || (d3 > 0)));
}

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const rad = size * 0.22;
  const tri = [[size * 0.37, size * 0.30], [size * 0.37, size * 0.70], [size * 0.76, size * 0.50]];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const cx = Math.min(Math.max(x, rad), size - rad);
      const cy = Math.min(Math.max(y, rad), size - rad);
      if (Math.hypot(x - cx, y - cy) > rad) continue; // transparent corner
      let r = 0x12, g = 0x16, b = 0x1e;
      if (inTriangle(x + 0.5, y + 0.5, tri[0], tri[1], tri[2])) { r = 0x3d; g = 0x7e; b = 0xff; }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

for (const s of [16, 32, 48, 128]) {
  const file = path.join(__dirname, `icon_${s}.png`);
  fs.writeFileSync(file, encodePNG(s, render(s)));
  console.log('wrote', file);
}
