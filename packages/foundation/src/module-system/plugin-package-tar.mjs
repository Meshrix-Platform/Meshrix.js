import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

const BLOCK = 512;
const MAX_ENTRIES = 256;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 32;
const MAX_PATH_DEPTH = 8;

function encodeOctal(value, length) {
  const text = Number(value).toString(8);
  if (text.length > length - 1) throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: tar header field overflow");
  return `${text.padStart(length - 1, "0")}\0`;
}

function checksum(header) {
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  return sum;
}

function writeString(buffer, offset, value, length) {
  const bytes = Buffer.from(String(value || ""), "utf8");
  if (bytes.length > length) throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: tar path too long");
  bytes.copy(buffer, offset);
}

export function createPluginPackageTarGz(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive requires files");
  }
  const chunks = [];
  let uncompressed = 0;
  for (const file of files) {
    const name = String(file.path || "");
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ""), "utf8");
    if (!name || name.includes("..") || name.startsWith("/") || name.split("/").length > MAX_PATH_DEPTH) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive path is unsafe");
    }
    uncompressed += content.length;
    if (uncompressed > MAX_BYTES) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive exceeds byte budget");
    }
    const header = Buffer.alloc(BLOCK, 0);
    writeString(header, 0, name, 100);
    header.write(encodeOctal(0o644, 8), 100, 8, "ascii");
    header.write(encodeOctal(0, 8), 108, 8, "ascii");
    header.write(encodeOctal(0, 8), 116, 8, "ascii");
    header.write(encodeOctal(content.length, 12), 124, 12, "ascii");
    header.write(encodeOctal(0, 12), 136, 12, "ascii");
    header.write("        ", 148, 8, "ascii");
    header.write("0", 156, 1, "ascii");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    const sum = checksum(header);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header);
    chunks.push(content);
    const pad = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar = Buffer.concat(chunks);
  return gzipSync(tar);
}

function readOctal(buffer, offset, length) {
  const text = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0/gu, "").trim();
  if (!text) return 0;
  return Number.parseInt(text, 8);
}

export function extractPluginPackageTarGz(archiveBytes, {
  maxBytes = MAX_BYTES,
  maxEntries = MAX_ENTRIES,
  maxExpansionRatio = MAX_EXPANSION_RATIO
} = {}) {
  if (!Buffer.isBuffer(archiveBytes) && !(archiveBytes instanceof Uint8Array)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive bytes are required");
  }
  const compressed = Buffer.from(archiveBytes);
  if (compressed.length === 0 || compressed.length > maxBytes) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive size is outside budget");
  }
  let tar;
  try {
    tar = gunzipSync(compressed);
  } catch {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive is not a gzip-compressed tar");
  }
  if (tar.length > maxBytes * maxExpansionRatio) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive expansion ratio exceeded");
  }
  const files = new Map();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0/gu, "").trim();
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const magic = header.subarray(257, 262).toString("ascii");
    if (magic !== "ustar") {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: unsupported tar format");
    }
    const expected = checksum(header);
    const actual = readOctal(header, 148, 8);
    if (expected !== actual) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: tar checksum mismatch");
    }
    if (!name || name.includes("..") || name.startsWith("/") || name.includes("\\")) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive path escapes bundle root");
    }
    if (name.split("/").filter(Boolean).length > MAX_PATH_DEPTH) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive path depth exceeded");
    }
    if (typeFlag !== "0" && typeFlag !== "\0") {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive entry type is not a regular file");
    }
    if (size < 0 || offset + size > tar.length) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive entry size is invalid");
    }
    const content = Buffer.from(tar.subarray(offset, offset + size));
    offset += size;
    offset += (BLOCK - (size % BLOCK)) % BLOCK;
    if (files.has(name)) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: duplicate archive entry");
    }
    files.set(name, content);
    if (files.size > maxEntries) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive entry count exceeded");
    }
  }
  if (files.size === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive contains no files");
  }
  return files;
}

export function sha256Digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
