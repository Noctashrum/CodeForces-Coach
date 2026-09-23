/**
 * gen-icon.js — 零依赖生成应用图标（CF Coach）
 * 设计：深海军蓝渐变圆角底 + 金色奖杯 + 青色光晕
 * 输出：build/icon.png（256×256）+ build/icon.ico（内嵌 PNG 的现代 ICO）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 绘制（2×2 超采样抗锯齿） ---------- */

const SIZE = 256;
const SS = 2;
const W = SIZE * SS;

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(px, x0 + r), x1 - r);
  const cy = Math.min(Math.max(py, y0 + r), y1 - r);
  return Math.hypot(px - cx, py - cy) - r;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

function drawIcon() {
  const rgba = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const px = x + 0.5, py = y + 0.5;
      const m = W * 0.045, r = W * 0.21;
      const dBg = sdRoundRect(px, py, m, m, W - m, W - m, r);
      const aa = Math.min(1, Math.max(0, 0.5 - dBg));
      if (aa <= 0) continue;
      // 背景：深海军蓝对角渐变 + 右上角青色光晕
      const t = (px + py) / (2 * W);
      const glow = Math.exp(-((px - W * 0.78) ** 2 + (py - W * 0.22) ** 2) / (2 * (W * 0.26) ** 2));
      let R = 13 + (22 - 13) * t + 9 * glow;
      let G = 27 + (55 - 27) * t + 13 * glow;
      let B = 46 + (79 - 46) * t + 20 * glow;

      // 奖杯（金色）
      const cup = { cx: W * 0.5, cy: W * 0.40, r: W * 0.215, rimY: W * 0.245, bottomY: W * 0.56 };
      const inCup = sdCircle(px, py, cup.cx, cup.cy, cup.r) <= 0 && py >= cup.rimY && py <= cup.bottomY;
      const rim = sdRoundRect(px, py, cup.cx - cup.r * 0.96, cup.rimY - W * 0.035, cup.cx + cup.r * 0.96, cup.rimY + W * 0.028, W * 0.03);
      const stem = sdRoundRect(px, py, cup.cx - W * 0.028, cup.bottomY - W * 0.01, cup.cx + W * 0.028, W * 0.705, W * 0.02);
      const base1 = sdRoundRect(px, py, cup.cx - W * 0.13, W * 0.695, cup.cx + W * 0.13, W * 0.745, W * 0.02);
      const base2 = sdRoundRect(px, py, cup.cx - W * 0.095, W * 0.75, cup.cx + W * 0.095, W * 0.79, W * 0.016);
      const hL = Math.abs(sdCircle(px, py, cup.cx - cup.r - W * 0.035, cup.cy + W * 0.02, W * 0.075)) - W * 0.024;
      const hR = Math.abs(sdCircle(px, py, cup.cx + cup.r + W * 0.035, cup.cy + W * 0.02, W * 0.075)) - W * 0.024;
      const isHandle = (hL <= 0 && px < cup.cx) || (hR <= 0 && px > cup.cx);
      if (inCup || rim <= 0 || stem <= 0 || base1 <= 0 || base2 <= 0 || isHandle) {
        const gy = py / W;
        R = 250 - 28 * gy; G = 217 - 45 * gy; B = 139 - 60 * gy;
        if (inCup && px < cup.cx - cup.r * 0.3) { R += 6; G += 6; B += 2; }
      }
      rgba[i] = Math.round(Math.min(255, R));
      rgba[i + 1] = Math.round(Math.min(255, G));
      rgba[i + 2] = Math.round(Math.min(255, B));
      rgba[i + 3] = Math.round(aa * 255);
    }
  }

  const out = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3];
        }
      }
      const n = SS * SS;
      const o = (y * SIZE + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function encodeICO(pngBuf) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0;
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuf]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = encodePNG(SIZE, SIZE, drawIcon());
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), encodeICO(png));
console.log('已生成: build/icon.png (' + png.length + ' bytes) + build/icon.ico');
