/**
 * Generates the extension icons as raw PNGs — no image dependencies.
 * Rounded square with an Instagram-ish gradient and a play glyph, drawn at 4x
 * and box-downsampled for antialiasing.
 */
import { deflateSync, crc32 } from "node:zlib";
import { writeFile, mkdir } from "node:fs/promises";

const SS = 4; // supersampling factor

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    rgba.copy(raw, o, y * size * 4, (y + 1) * size * 4);
    o += size * 4;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const lerp = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle centred on the tile. */
function roundedRectSdf(x, y, n, radius) {
  const half = n / 2;
  const dx = Math.abs(x - half) - (half - radius);
  const dy = Math.abs(y - half) - (half - radius);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - radius;
}

function insideTriangle(x, y, n) {
  // Play glyph, vertically centred, slightly right-weighted like a real player.
  const left = n * 0.38;
  const right = n * 0.70;
  const top = n * 0.28;
  const bottom = n * 0.72;
  if (x < left || x > right) return false;
  const t = (x - left) / (right - left);
  const halfHeight = ((bottom - top) / 2) * (1 - t);
  const mid = (top + bottom) / 2;
  return y >= mid - halfHeight && y <= mid + halfHeight;
}

function render(size) {
  const n = size * SS;
  const big = new Float64Array(n * n * 4);

  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = (y * n + x) * 4;
      const inTile = roundedRectSdf(x + 0.5, y + 0.5, n, n * 0.22) <= 0;
      if (!inTile) continue;

      // Diagonal gradient: amber -> magenta -> indigo.
      const t = (x / n) * 0.5 + (1 - y / n) * 0.5;
      let r, g, b;
      if (t < 0.5) {
        const k = t / 0.5;
        r = lerp(252, 214, k);
        g = lerp(175, 46, k);
        b = lerp(69, 140, k);
      } else {
        const k = (t - 0.5) / 0.5;
        r = lerp(214, 88, k);
        g = lerp(46, 60, k);
        b = lerp(140, 224, k);
      }

      if (insideTriangle(x + 0.5, y + 0.5, n)) {
        r = 255;
        g = 255;
        b = 255;
      }
      big[i] = r;
      big[i + 1] = g;
      big[i + 2] = b;
      big[i + 3] = 255;
    }
  }

  // Box downsample.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const i = ((y * SS + sy) * n + (x * SS + sx)) * 4;
          const alpha = big[i + 3] / 255;
          r += big[i] * alpha;
          g += big[i + 1] * alpha;
          b += big[i + 2] * alpha;
          a += alpha;
        }
      }
      const count = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = a > 0 ? Math.round(r / a) : 0;
      out[o + 1] = a > 0 ? Math.round(g / a) : 0;
      out[o + 2] = a > 0 ? Math.round(b / a) : 0;
      out[o + 3] = Math.round((a / count) * 255);
    }
  }
  return out;
}

await mkdir("public/icons", { recursive: true });
for (const size of [16, 48, 128]) {
  await writeFile(`public/icons/icon${size}.png`, encodePng(size, render(size)));
  console.log(`[igvc] wrote public/icons/icon${size}.png`);
}
