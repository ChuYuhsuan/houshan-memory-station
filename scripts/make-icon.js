'use strict';

/**
 * 生成应用图标（不依赖任何第三方包）：
 * 圆角渐变底 + 白色"蛋" + 右下角金色对勾徽章。
 * 输出 build/icon.ico（多尺寸）与 build/icon.png（512）。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'build');

// ---------- PNG / CRC ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- 作图 ----------
const BASE = 1536; // 以 1536 渲染，再按整数倍降采样得到各尺寸，天然抗锯齿
const U = BASE / 1024; // 设计稿按 1024 布局

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function roundedRectSD(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

// 蛋形：下半部略宽
function eggSD(px, py, cx, cy, rx, ry, widen) {
  const t = (py - cy) / ry;
  const s = 1 - widen * t;
  const u = (px - cx) / (rx * s);
  const f = Math.hypot(u, t) - 1;
  return f * Math.min(rx, ry); // 近似像素距离
}

function segmentDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  const t = clamp01((wx * vx + wy * vy) / len2);
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

function renderMaster() {
  const buf = Buffer.alloc(BASE * BASE * 4);
  const cx = BASE / 2;
  const cy = BASE / 2;

  // 底色渐变端点
  const c1 = [74, 158, 127]; // #4a9e7f
  const c2 = [109, 177, 214]; // #6db1d6
  const c3 = [58, 127, 102]; // #3a7f66

  const eggCx = cx;
  const eggCy = 512 * U;
  const eggRx = 198 * U;
  const eggRy = 248 * U;

  const badgeCx = 736 * U;
  const badgeCy = 742 * U;
  const badgeR = 138 * U;

  const ax = 668 * U;
  const ay = 744 * U;
  const bx = 714 * U;
  const by = 792 * U;
  const dx = 808 * U;
  const dy = 676 * U;
  const stroke = 46 * U;

  for (let y = 0; y < BASE; y++) {
    for (let x = 0; x < BASE; x++) {
      const i = (y * BASE + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // ---- 圆角底 ----
      const sdBase = roundedRectSD(x + 0.5, y + 0.5, cx, cy, 480 * U, 480 * U, 224 * U);
      const aBase = clamp01(0.5 - sdBase / 1.6);
      if (aBase > 0) {
        const t = clamp01((x + y) / (2 * BASE));
        let cr = lerp(c1[0], c2[0], t);
        let cg = lerp(c1[1], c2[1], t);
        let cb = lerp(c1[2], c2[2], t);
        // 右下角压深一点，增强立体感
        const shade = smooth(0.45, 1.0, (x + y) / (2 * BASE)) * 0.18;
        cr = lerp(cr, c3[0], shade);
        cg = lerp(cg, c3[1], shade);
        cb = lerp(cb, c3[2], shade);
        // 左上角柔光
        const dLight = Math.hypot(x - 0.26 * BASE, y - 0.2 * BASE) / (0.62 * BASE);
        const light = clamp01(1 - dLight) * 0.16;
        r = lerp(cr, 255, light);
        g = lerp(cg, 255, light);
        b = lerp(cb, 255, light);
        a = aBase;
      }

      // ---- 蛋 ----
      const sdEgg = eggSD(x + 0.5, y + 0.5, eggCx, eggCy + 14 * U, eggRx, eggRy, 0.14);
      const aEgg = clamp01(0.5 - sdEgg / 1.6);
      if (aEgg > 0) {
        // 蛋面轻微暖白渐变，避免死白
        const gt = clamp01((y - (eggCy - eggRy)) / (2 * eggRy));
        const er = lerp(255, 247, gt * 0.55);
        const eg = lerp(255, 249, gt * 0.55);
        const eb = lerp(255, 243, gt * 0.55);
        r = lerp(r, er, aEgg);
        g = lerp(g, eg, aEgg);
        b = lerp(b, eb, aEgg);
        a = Math.max(a, aEgg * (a > 0 ? 1 : 1));
        if (a < aEgg) a = aEgg;
      }

      // ---- 金色徽章 ----
      const sdBadge = Math.hypot(x + 0.5 - badgeCx, y + 0.5 - badgeCy) - badgeR;
      const aBadge = clamp01(0.5 - sdBadge / 1.6);
      if (aBadge > 0) {
        const bt = clamp01((x - (badgeCx - badgeR)) / (2 * badgeR));
        const br = lerp(224, 201, bt);
        const bg = lerp(170, 138, bt);
        const bb = lerp(65, 47, bt);
        r = lerp(r, br, aBadge);
        g = lerp(g, bg, aBadge);
        b = lerp(b, bb, aBadge);
        if (a < aBadge) a = aBadge;
      }

      // ---- 白色对勾 ----
      const d1 = segmentDist(x + 0.5, y + 0.5, ax, ay, bx, by);
      const d2 = segmentDist(x + 0.5, y + 0.5, bx, by, dx, dy);
      const sdCheck = Math.min(d1, d2) - stroke / 2;
      const aCheck = clamp01(0.5 - sdCheck / 1.6);
      if (aCheck > 0) {
        r = lerp(r, 255, aCheck);
        g = lerp(g, 255, aCheck);
        b = lerp(b, 255, aCheck);
      }

      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(a * 255);
    }
  }
  return buf;
}

function downsample(master, size) {
  const step = BASE / size;
  const out = Buffer.alloc(size * size * 4);
  const n = step * step;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < step; sy++) {
        for (let sx = 0; sx < step; sx++) {
          const i = ((y * step + sy) * BASE + (x * step + sx)) * 4;
          const alpha = master[i + 3] / 255;
          r += master[i] * alpha;
          g += master[i + 1] * alpha;
          b += master[i + 2] * alpha;
          a += alpha;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

function buildICO(entries) {
  // entries: [{ size, png }]
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirs = [];
  let offset = 6 + count * 16;
  const images = [];
  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    offset += png.length;
    dirs.push(dir);
    images.push(png);
  }
  return Buffer.concat([header, ...dirs, ...images]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('渲染主图…');
  const master = renderMaster();

  const icoSizes = [256, 128, 64, 48, 32, 24, 16];
  const entries = icoSizes.map((size) => ({ size, png: encodePNG(size, size, downsample(master, size)) }));

  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), buildICO(entries));
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), encodePNG(512, 512, downsample(master, 512)));
  console.log('已生成 build/icon.ico 与 build/icon.png');
}

main();
