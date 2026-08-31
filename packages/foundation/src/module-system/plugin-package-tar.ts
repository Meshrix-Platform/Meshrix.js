import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, gzipSync } from "node:zlib";

const BLOCK: any = 512;
const MAX_ENTRIES: any = 256;
const MAX_BYTES: any = 16 * 1024 * 1024;
const MAX_EXPANSION_RATIO: any = 32;
const MAX_PATH_DEPTH: any = 8;

function encodeOctal(value?: any, length?: any) : any {
  const text: any = Number(value).toString(8);
  if (text.length > length - 1) throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: tar header field overflow");
  return `${text.padStart(length - 1, "0")}\0`;
}

function checksum(header?: any) : any {
  let sum: any = 0;
  for (let index: any = 0; index < BLOCK; index += 1) {
    sum += index >= 148 && index < 156 ? 32 : header[index];
  }
  return sum;
}

function writeString(buffer?: any, offset?: any, value?: any, length?: any) : any {
  const bytes: any = Buffer.from(String(value || ""), "utf8");
  if (bytes.length > length) throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: tar path too long");
  bytes.copy(buffer, offset);
}

export function createPluginPackageTarGz(files?: any) : any {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive requires files");
  }
  const chunks: any[] = [];
  let uncompressed: any = 0;
  for (const file of files) {
    const name: any = String(file.path || "");
    const content: any = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content || ""), "utf8");
    if (!name || name.includes("..") || name.startsWith("/") || name.split("/").length > MAX_PATH_DEPTH) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive path is unsafe");
    }
    uncompressed += content.length;
    if (uncompressed > MAX_BYTES) {
      throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive exceeds byte budget");
    }
    const header: any = Buffer.alloc(BLOCK, 0);
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
    const sum: any = checksum(header);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    chunks.push(header);
    chunks.push(content);
    const pad: any = (BLOCK - (content.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  const tar: any = Buffer.concat(chunks);
  return gzipSync(tar);
}

function readOctal(buffer?: any, offset?: any, length?: any) : any {
  const text: any = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0/gu, "").trim();
  if (!text) return 0;
  return Number.parseInt(text, 8);
}

export async function extractPluginPackageTarGz(archiveBytes?: any, {
  maxBytes = MAX_BYTES,
  maxEntries = MAX_ENTRIES,
  maxExpansionRatio = MAX_EXPANSION_RATIO,
  signal = null
}: Record<string, any> = {}) : Promise<any> {
  if (!Buffer.isBuffer(archiveBytes) && !(archiveBytes instanceof Uint8Array)) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive bytes are required");
  }
  const compressed: any = Buffer.from(archiveBytes);
  if (compressed.length === 0 || compressed.length > maxBytes) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive size is outside budget");
  }
  const files: any = new Map<any, any>();
  let state: "header" | "body" | "padding" | "end" = "header";
  let pending: any = Buffer.alloc(0);
  let currentName: any = "";
  let currentSize: any = 0;
  let currentRead: any = 0;
  let currentChunks: any[] = [];
  let paddingRemaining: any = 0;
  let endBlocks: any = 0;
  let expandedBytes: any = 0;
  let retainedBytes: any = 0;

  const fail: any = (message?: any) : never => {
    throw new Error(`PLUGIN_PACKAGE_FORMAT_REJECTED: ${message}`);
  };
  const finishMember: any = () : any => {
    const content: any = Buffer.concat(currentChunks, currentSize);
    files.set(currentName, content);
    retainedBytes += content.length;
    if (retainedBytes > maxBytes) fail("archive exceeds byte budget");
    currentName = "";
    currentSize = 0;
    currentRead = 0;
    currentChunks = [];
  };
  const consume: any = (input?: any) : any => {
    let chunk: any = Buffer.from(input);
    expandedBytes += chunk.length;
    if (expandedBytes > maxBytes) fail("archive expansion byte budget exceeded");
    if (expandedBytes > compressed.length * maxExpansionRatio) fail("archive expansion ratio exceeded");
    while (chunk.length > 0) {
      if (state === "body") {
        const take: any = Math.min(currentSize - currentRead, chunk.length);
        if (take > 0) currentChunks.push(Buffer.from(chunk.subarray(0, take)));
        currentRead += take;
        chunk = chunk.subarray(take);
        if (currentRead === currentSize) {
          finishMember();
          state = paddingRemaining > 0 ? "padding" : "header";
        }
        continue;
      }
      if (state === "padding") {
        const take: any = Math.min(paddingRemaining, chunk.length);
        paddingRemaining -= take;
        chunk = chunk.subarray(take);
        if (paddingRemaining === 0) state = "header";
        continue;
      }
      const needed: any = BLOCK - pending.length;
      const take: any = Math.min(needed, chunk.length);
      pending = pending.length === 0
        ? Buffer.from(chunk.subarray(0, take))
        : Buffer.concat([pending, chunk.subarray(0, take)], pending.length + take);
      chunk = chunk.subarray(take);
      if (pending.length < BLOCK) continue;
      const header: any = pending;
      pending = Buffer.alloc(0);
      const zeroBlock: any = header.every((byte?: any) : any => byte === 0);
      if (state === "end") {
        if (!zeroBlock) fail("archive has data after end markers");
        endBlocks += 1;
        continue;
      }
      if (zeroBlock) {
        state = "end";
        endBlocks = 1;
        continue;
      }
      const name: any = header.subarray(0, 100).toString("utf8").replace(/\0/gu, "").trim();
      const size: any = readOctal(header, 124, 12);
      const typeFlag: any = String.fromCharCode(header[156] || 48);
      const magic: any = header.subarray(257, 262).toString("ascii");
      if (magic !== "ustar") fail("unsupported tar format");
      if (checksum(header) !== readOctal(header, 148, 8)) fail("tar checksum mismatch");
      if (!name || name.includes("..") || name.startsWith("/") || name.includes("\\")) {
        fail("archive path escapes bundle root");
      }
      if (name.split("/").filter(Boolean).length > MAX_PATH_DEPTH) fail("archive path depth exceeded");
      if (typeFlag !== "0" && typeFlag !== "\0") fail("archive entry type is not a regular file");
      if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) fail("archive entry size is invalid");
      if (files.has(name)) fail("duplicate archive entry");
      if (files.size + 1 > maxEntries) fail("archive entry count exceeded");
      currentName = name;
      currentSize = size;
      currentRead = 0;
      currentChunks = [];
      paddingRemaining = (BLOCK - (size % BLOCK)) % BLOCK;
      if (size === 0) {
        finishMember();
        state = paddingRemaining > 0 ? "padding" : "header";
      } else {
        state = "body";
      }
    }
  };

  if (signal?.aborted) fail("archive admission cancelled");
  const sink: any = new Writable({
    write(chunk?: any, _encoding?: any, callback?: any) {
      try {
        if (signal?.aborted) fail("archive admission cancelled");
        consume(chunk);
        callback();
      } catch (error: any) {
        callback(error);
      }
    }
  });
  try {
    await pipeline(Readable.from([compressed]), createGunzip(), sink, signal ? { signal } : {});
  } catch (error: any) {
    if (String(error?.message || "").startsWith("PLUGIN_PACKAGE_FORMAT_REJECTED:")) throw error;
    if (signal?.aborted || error?.name === "AbortError") fail("archive admission cancelled");
    fail("archive is not a gzip-compressed tar");
  }
  if ((state as string) !== "end" || endBlocks < 2 || pending.length !== 0) fail("archive is truncated");
  if (files.size === 0) {
    throw new Error("PLUGIN_PACKAGE_FORMAT_REJECTED: archive contains no files");
  }
  return files;
}

export function sha256Digest(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
