/**
 * Generate the Tauri bundle icons for the Meshrix Entry shell.
 *
 * `node tools/generate-icons.mjs` rewrites src-tauri/icons/*.png, icon.ico
 * and icon.icns. The artwork is a flat rounded-square mark — deterministic,
 * no external assets. PNG is encoded by hand (zlib + CRC32); the .ico wraps
 * a PNG payload (valid since Windows Vista) and the .icns wraps PNG payloads
 * (the modern PNG-based icns entries).
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ICONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA canvas → PNG buffer (8-bit RGBA, filter 0 per row). */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** The product mark: rounded square + a simple "M" stroke. */
function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const radius = size * 0.22;
  const bg = [0x34, 0x57, 0xd5, 0xff];
  const fg = [0xff, 0xff, 0xff, 0xff];
  const stroke = size * 0.075;
  // M: two verticals + a chevron between them.
  const mx1 = size * 0.30, mx2 = size * 0.70;
  const my1 = size * 0.66, my2 = size * 0.34; // baseline to top
  const mid = size * 0.50;
  const segments = [
    [mx1, my1, mx1, my2],
    [mx2, my1, mx2, my2],
    [mx1, my2, mid, my1 - (my1 - my2) * 0.55],
    [mid, my1 - (my1 - my2) * 0.55, mx2, my2]
  ];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      // Rounded-square alpha mask.
      const cx = Math.max(radius, Math.min(size - radius, x)) - x;
      const cy = Math.max(radius, Math.min(size - radius, y)) - y;
      const inBox = Math.hypot(cx, cy) <= radius;
      const color = inBox ? bg : [0, 0, 0, 0];
      rgba[i] = color[0];
      rgba[i + 1] = color[1];
      rgba[i + 2] = color[2];
      rgba[i + 3] = color[3];
      if (inBox && segments.some(([a, b, c, d]) => distToSegment(x, y, a, b, c, d) <= stroke / 2)) {
        rgba[i] = fg[0];
        rgba[i + 1] = fg[1];
        rgba[i + 2] = fg[2];
        rgba[i + 3] = fg[3];
      }
    }
  }
  return rgba;
}

/** .ico container carrying one PNG image (the 256px master). */
function encodeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0);
  entry.writeUInt8(size >= 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12);
  return Buffer.concat([header, entry, png]);
}

/** .icns container carrying PNG images (ic07 = 256, ic10 = 1024, ic08 = 512). */
function encodeIcns(entries) {
  const parts = [Buffer.from("icns", "latin1")];
  const body = entries.map(([type, png]) =>
    Buffer.concat([Buffer.from(type, "latin1"), uint32(png.length + 8), png])
  );
  const total = 8 + body.reduce((sum, part) => sum + part.length, 0);
  return Buffer.concat([...parts.slice(0, 1), uint32(total), ...body]);

  function uint32(value) {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value, 0);
    return out;
  }
}

mkdirSync(ICONS_DIR, { recursive: true });
const sizes = { "32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256 };
const png256 = encodePng(256, 256, drawIcon(256));
const png512 = encodePng(512, 512, drawIcon(512));
const png1024 = encodePng(1024, 1024, drawIcon(1024));
for (const [name, size] of Object.entries(sizes)) {
  writeFileSync(join(ICONS_DIR, name), size === 256 ? png256 : encodePng(size, size, drawIcon(size)));
}
writeFileSync(join(ICONS_DIR, "icon.ico"), encodeIco(png256, 256));
writeFileSync(join(ICONS_DIR, "icon.icns"), encodeIcns([["ic07", png256], ["ic08", png512], ["ic10", png1024]]));
console.log(`icons written to ${ICONS_DIR}`);
