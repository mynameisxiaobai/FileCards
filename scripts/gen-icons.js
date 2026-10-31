'use strict';

/**
 * 生成图标：
 *   assets/tray.png  — 32×32，托盘用
 *   assets/icon.png  — 256×256，打包 exe 用（electron-builder 会用它转 ico）
 *
 * 手写 PNG 编码，不引任何图形库，zlib 只用 Node 内置。
 * 运行：node scripts/gen-icons.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- CRC32 ---------------------------------------------------------------
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
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ---- 绘制 ----------------------------------------------------------------

/**
 * 渲染一张 size×size 的图标。
 * 所有几何量都以 32px 设计稿为基准，按 size/32 等比放大，
 * 这样托盘图和小图标的形状完全一致。
 */
function render(size) {
  const px = new Uint8Array(size * size * 4); // RGBA
  const k = size / 32; // 缩放系数

  function blend(x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    const sa = a / 255;
    const da = px[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa === 0) return;
    px[i] = Math.round((r * sa + px[i] * da * (1 - sa)) / oa);
    px[i + 1] = Math.round((g * sa + px[i + 1] * da * (1 - sa)) / oa);
    px[i + 2] = Math.round((b * sa + px[i + 2] * da * (1 - sa)) / oa);
    px[i + 3] = Math.round(oa * 255);
  }

  /** 圆角矩形，4×4 超采样抗锯齿；color 可以是 [r,g,b] 或 (t)=>[r,g,b] 竖向渐变 */
  function roundRect(x0, y0, w, h, rad, color, alpha = 255) {
    const ss = 4;
    const X0 = x0 * k;
    const Y0 = y0 * k;
    const W = w * k;
    const H = h * k;
    const R = rad * k;
    const xs = Math.floor(X0);
    const xe = Math.ceil(X0 + W);
    const ys = Math.floor(Y0);
    const ye = Math.ceil(Y0 + H);

    for (let y = ys; y < ye; y++) {
      for (let x = xs; x < xe; x++) {
        let hit = 0;
        for (let sy = 0; sy < ss; sy++) {
          for (let sx = 0; sx < ss; sx++) {
            const fx = x + (sx + 0.5) / ss;
            const fy = y + (sy + 0.5) / ss;
            const cx = Math.min(Math.max(fx, X0 + R), X0 + W - R);
            const cy = Math.min(Math.max(fy, Y0 + R), Y0 + H - R);
            const dx = fx - cx;
            const dy = fy - cy;
            if (dx * dx + dy * dy <= R * R) hit++;
          }
        }
        if (hit > 0) {
          const c = typeof color === 'function' ? color((y - ys) / Math.max(1, ye - ys)) : color;
          blend(x, y, c[0], c[1], c[2], (alpha * hit) / (ss * ss));
        }
      }
    }
  }

  // 底：深色圆角方块，自上而下极轻微渐变，避免大尺寸下发死
  roundRect(2, 2, 28, 28, 8, (t) => {
    const top = [44, 49, 57];
    const bot = [22, 25, 30];
    return [
      Math.round(top[0] + (bot[0] - top[0]) * t),
      Math.round(top[1] + (bot[1] - top[1]) * t),
      Math.round(top[2] + (bot[2] - top[2]) * t),
    ];
  });

  // 两张"卡片"，右边一张降低不透明度表示"待归档"
  roundRect(8, 9, 7, 10, 2.2, [255, 255, 255]);
  roundRect(17, 9, 7, 10, 2.2, [255, 255, 255], 140);
  // 底部一条蓝色"收纳槽"，对应界面里的强调色 #2f6feb
  roundRect(8, 22, 16, 2.4, 1.2, [77, 137, 255]);

  return px;
}

function encodePng(size, px) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < size * 4; x++) raw[y * stride + 1 + x] = px[y * size * 4 + x];
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 输出 ----------------------------------------------------------------
const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });

for (const [name, size] of [
  ['tray.png', 32],
  ['icon.png', 256],
]) {
  const png = encodePng(size, render(size));
  const out = path.join(outDir, name);
  fs.writeFileSync(out, png);
  console.log(`wrote ${name}  ${size}×${size}  ${png.length} bytes`);
}
