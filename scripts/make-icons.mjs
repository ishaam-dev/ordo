#!/usr/bin/env node
/**
 * Generates every icon the Mac app needs, from code — no design tool, no binary
 * assets checked in, no image libraries.
 *
 *   assets/icon.icns             app icon (Dock, /Applications, Finder)
 *   assets/icon.png              1024px source of the same
 *   assets/trayTemplate.png      menubar icon, "everything is fine"      (+ @2x)
 *   assets/tray-startingTemplate.png  menubar icon, "starting up"        (+ @2x)
 *   assets/tray-offTemplate.png  menubar icon, "not connected"           (+ @2x)
 *
 * Menubar icons are macOS *template* images: pure black + alpha, which macOS
 * recolors itself so they stay legible in light mode, dark mode and when the
 * menubar item is highlighted. Electron switches an image into template mode
 * automatically when the filename ends in "Template".
 *
 * Run: node scripts/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(root, 'assets');

/* ------------------------------------------------------------------ PNG ---- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
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

/** rgba: Uint8Array of size*size*4, non-premultiplied. */
function encodePng(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------- signed distance ---- */
// Everything is drawn as a signed distance field in a 16x16 "design space" and
// supersampled, which gives clean antialiasing at any output size.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function sdRoundBox(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay;
  const e1x = cx - bx, e1y = cy - by;
  const e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay;
  const v1x = px - bx, v1y = py - by;
  const v2x = px - cx, v2y = py - cy;
  const h0 = clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y), 0, 1);
  const h1 = clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y), 0, 1);
  const h2 = clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y), 0, 1);
  const p0x = v0x - e0x * h0, p0y = v0y - e0y * h0;
  const p1x = v1x - e1x * h1, p1y = v1y - e1y * h1;
  const p2x = v2x - e2x * h2, p2y = v2y - e2y * h2;
  const s = Math.sign(e0x * e2y - e0y * e2x);
  const d = Math.min(
    Math.min(p0x * p0x + p0y * p0y, p1x * p1x + p1y * p1y),
    p2x * p2x + p2y * p2y,
  );
  const sign = Math.min(
    Math.min(s * (v0x * e0y - v0y * e0x), s * (v1x * e1y - v1y * e1x)),
    s * (v2x * e2y - v2y * e2x),
  );
  return -Math.sqrt(d) * Math.sign(sign);
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

/* ------------------------------------------------------------- the glyph ---- */
// A speech bubble: everything in the app is "someone said something to you".

const BUBBLE = { cx: 8, cy: 7.05, hw: 6.5, hh: 4.55, r: 2.15 };
const TAIL = { ax: 4.6, ay: 10.6, bx: 4.0, by: 14.5, cx: 8.7, cy: 10.9 };

/** Signed distance to the bubble outline+tail as one shape. */
function bubbleDistance(x, y) {
  return Math.min(
    sdRoundBox(x, y, BUBBLE.cx, BUBBLE.cy, BUBBLE.hw, BUBBLE.hh, BUBBLE.r),
    sdTriangle(x, y, TAIL.ax, TAIL.ay, TAIL.bx, TAIL.by, TAIL.cx, TAIL.cy),
  );
}

/**
 * Coverage (0..1) of the menubar glyph at design-space point (x, y).
 *   'ok'       filled bubble        — running normally
 *   'starting' hollow bubble        — still waking up
 *   'off'      hollow bubble, slash — not connected
 */
function trayCoverage(x, y, variant) {
  const d = bubbleDistance(x, y);
  if (variant === 'ok') return d < 0 ? 1 : 0;

  const outline = Math.abs(d) - 0.92 < 0 ? 1 : 0;
  if (variant === 'starting') return outline;

  // 'off': punch a gap around the slash so the two shapes stay readable.
  const slash = sdSegment(x, y, 3.0, 13.4, 13.2, 2.4);
  const gap = slash - 1.75 < 0 ? 1 : 0;
  const bar = slash - 0.92 < 0 ? 1 : 0;
  return Math.max(outline * (1 - gap), bar);
}

function renderTray(size, variant) {
  const rgba = new Uint8Array(size * size * 4);
  const SS = 8; // supersampling factor
  const scale = 16 / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) * scale;
          const y = (py + (sy + 0.5) / SS) * scale;
          acc += trayCoverage(x, y, variant);
        }
      }
      const a = Math.round((acc / (SS * SS)) * 255);
      const i = (py * size + px) * 4;
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = a; // black + alpha
    }
  }
  return encodePng(rgba, size);
}

/* --------------------------------------------------------- the app icon ---- */
// macOS app icon: rounded square with a margin, gradient fill, white bubble,
// amber dot for "something needs you".

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

const TOP = [0x4c, 0x6e, 0xf5];    // indigo
const BOTTOM = [0x7b, 0x3f, 0xe4]; // violet
const AMBER = [0xff, 0xb0, 0x20];

function renderAppIcon(size) {
  const rgba = new Uint8Array(size * size * 4);
  const SS = size <= 64 ? 6 : 3;
  const u = size / 1024; // 1 design unit = 1/1024 of the canvas

  // Rounded square: 824x824 centred in 1024, Big-Sur-ish corner radius.
  const plateHalf = 412 * u;
  const plateR = 185 * u;
  const c = size / 2;

  // Bubble, scaled from the 16-unit design space into the plate.
  const bubbleScale = (560 * u) / 16;
  const bubbleOx = c - 8 * bubbleScale;
  const bubbleOy = c - 8.2 * bubbleScale;

  const dotCx = c + 200 * u;
  const dotCy = c - 165 * u;
  const dotR = 92 * u;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rAcc = 0, gAcc = 0, bAcc = 0, aAcc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;

          const plate = sdRoundBox(x, y, c, c, plateHalf, plateHalf, plateR);
          if (plate >= 0) continue;

          const t = clamp((y - (c - plateHalf)) / (plateHalf * 2), 0, 1);
          let col = mix(TOP, BOTTOM, t);

          const bx = (x - bubbleOx) / bubbleScale;
          const by = (y - bubbleOy) / bubbleScale;
          if (bubbleDistance(bx, by) < 0) col = [0xff, 0xff, 0xff];

          // amber badge with a clean cut-out ring so it reads on the bubble
          if (sdCircle(x, y, dotCx, dotCy, dotR + 26 * u) < 0) col = mix(TOP, BOTTOM, t);
          if (sdCircle(x, y, dotCx, dotCy, dotR) < 0) col = AMBER;

          rAcc += col[0]; gAcc += col[1]; bAcc += col[2]; aAcc += 1;
        }
      }
      const n = SS * SS;
      const i = (py * size + px) * 4;
      if (aAcc === 0) continue;
      // Non-premultiplied: average colour over the covered samples only.
      rgba[i] = Math.round(rAcc / aAcc);
      rgba[i + 1] = Math.round(gAcc / aAcc);
      rgba[i + 2] = Math.round(bAcc / aAcc);
      rgba[i + 3] = Math.round((aAcc / n) * 255);
    }
  }
  return encodePng(rgba, size);
}

/* ------------------------------------------------------------------ main ---- */

mkdirSync(assetsDir, { recursive: true });

for (const [name, variant] of [
  ['trayTemplate', 'ok'],
  ['tray-startingTemplate', 'starting'],
  ['tray-offTemplate', 'off'],
]) {
  writeFileSync(path.join(assetsDir, `${name}.png`), renderTray(16, variant));
  writeFileSync(path.join(assetsDir, `${name}@2x.png`), renderTray(32, variant));
}
console.log('menubar icons ->', assetsDir);

const iconset = path.join(assetsDir, 'icon.iconset');
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });
for (const [pt, scale] of [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2],
  [256, 1], [256, 2], [512, 1], [512, 2],
]) {
  const px = pt * scale;
  const file = scale === 1 ? `icon_${pt}x${pt}.png` : `icon_${pt}x${pt}@2x.png`;
  writeFileSync(path.join(iconset, file), renderAppIcon(px));
}
writeFileSync(path.join(assetsDir, 'icon.png'), renderAppIcon(1024));

execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assetsDir, 'icon.icns')]);
rmSync(iconset, { recursive: true, force: true });
console.log('app icon    ->', path.join(assetsDir, 'icon.icns'));
