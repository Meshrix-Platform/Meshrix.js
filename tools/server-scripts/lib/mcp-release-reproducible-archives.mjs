import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const REPRODUCIBLE_TAR_MTIME_SECONDS = 315532800;

async function collectArchiveEntries(stagingRoot, outputDir) {
  const entries = [];
  async function visit(absolutePath) {
    const stat = await fs.lstat(absolutePath);
    if (stat.isSymbolicLink()) throw new Error("portable_archive_symlink_rejected");
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error("portable_archive_special_file_rejected");
    }
    const archivePath = path.relative(outputDir, absolutePath).split(path.sep).join("/");
    if (!archivePath || archivePath.startsWith("../") || archivePath.includes("\u0000")) {
      throw new Error("portable_archive_path_invalid");
    }
    entries.push({
      absolutePath,
      archivePath,
      directory: stat.isDirectory(),
      sizeBytes: stat.isFile() ? stat.size : 0,
      mode: stat.isDirectory() || (stat.mode & 0o111) !== 0 ? 0o755 : 0o644
    });
    if (!stat.isDirectory()) return;
    const children = await fs.readdir(absolutePath);
    children.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const child of children) await visit(path.join(absolutePath, child));
  }
  await visit(stagingRoot);
  return entries;
}

function writeTarString(header, offset, length, value, errorCode) {
  const encoded = Buffer.from(String(value), "utf8");
  if (encoded.length > length) throw new Error(errorCode);
  encoded.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = Number(value).toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error("portable_archive_numeric_field_overflow");
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function splitUstarPath(archivePath) {
  if (Buffer.byteLength(archivePath) <= 100) return { name: archivePath, prefix: "" };
  for (
    let index = archivePath.lastIndexOf("/");
    index > 0;
    index = archivePath.lastIndexOf("/", index - 1)
  ) {
    const prefix = archivePath.slice(0, index);
    const name = archivePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }
  throw new Error("portable_archive_path_too_long");
}

function createUstarHeader(entry) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitUstarPath(entry.archivePath);
  writeTarString(header, 0, 100, name, "portable_archive_path_too_long");
  writeTarOctal(header, 100, 8, entry.mode);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, entry.sizeBytes);
  writeTarOctal(header, 136, 12, REPRODUCIBLE_TAR_MTIME_SECONDS);
  header.fill(0x20, 148, 156);
  header[156] = entry.directory ? 0x35 : 0x30;
  writeTarString(header, 257, 6, "ustar\u0000", "portable_archive_header_invalid");
  writeTarString(header, 263, 2, "00", "portable_archive_header_invalid");
  writeTarString(header, 265, 32, "root", "portable_archive_header_invalid");
  writeTarString(header, 297, 32, "root", "portable_archive_header_invalid");
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  writeTarString(header, 345, 155, prefix, "portable_archive_path_too_long");
  const checksum = header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, "0");
  header.write(checksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

async function writeWithBackpressure(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, "drain");
}

async function createTarGzip(archivePath, entries) {
  const tarStream = new PassThrough();
  const archiveStream = createWriteStream(archivePath, { flags: "wx", mode: 0o644 });
  const archivePipeline = pipeline(tarStream, createGzip({ level: 9, mtime: 0 }), archiveStream);
  try {
    for (const entry of entries) {
      await writeWithBackpressure(tarStream, createUstarHeader(entry));
      if (entry.directory) continue;
      let writtenBytes = 0;
      for await (const chunk of createReadStream(entry.absolutePath)) {
        writtenBytes += chunk.length;
        await writeWithBackpressure(tarStream, chunk);
      }
      if (writtenBytes !== entry.sizeBytes) {
        throw new Error("portable_archive_source_changed_during_packaging");
      }
      const paddingBytes = (512 - (writtenBytes % 512)) % 512;
      if (paddingBytes > 0) await writeWithBackpressure(tarStream, Buffer.alloc(paddingBytes));
    }
    await writeWithBackpressure(tarStream, Buffer.alloc(1024));
    tarStream.end();
    await archivePipeline;
  } catch (error) {
    tarStream.destroy(error);
    archiveStream.destroy(error);
    await archivePipeline.catch(() => {});
    await fs.rm(archivePath, { force: true });
    throw error;
  }
}

async function createZipArchive(zipArchivePath, entries) {
  const { Zip, ZipDeflate, ZipPassThrough } = await import("fflate");
  const output = createWriteStream(zipArchivePath, { flags: "wx", mode: 0o644 });
  let outputBackpressure = Promise.resolve();
  let settle;
  let reject;
  const completed = new Promise((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  });
  output.once("finish", settle);
  output.once("error", reject);
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      reject(error);
      output.destroy(error);
      return;
    }
    if (chunk?.length && !output.write(Buffer.from(chunk))) {
      outputBackpressure = once(output, "drain");
    }
    if (final) output.end();
  });
  try {
    for (const entry of entries) {
      const zipEntry = entry.directory
        ? new ZipPassThrough(`${entry.archivePath}/`)
        : new ZipDeflate(entry.archivePath, { level: 9 });
      zipEntry.mtime = new Date(1980, 0, 1, 0, 0, 0, 0);
      zipEntry.os = 3;
      zipEntry.attrs = (((entry.directory ? 0o040000 : 0o100000) | entry.mode) << 16) >>> 0;
      zip.add(zipEntry);
      if (entry.directory) {
        zipEntry.push(new Uint8Array(), true);
      } else {
        let writtenBytes = 0;
        for await (const chunk of createReadStream(entry.absolutePath)) {
          writtenBytes += chunk.length;
          zipEntry.push(new Uint8Array(chunk));
          await outputBackpressure;
        }
        if (writtenBytes !== entry.sizeBytes) {
          throw new Error("portable_archive_source_changed_during_packaging");
        }
        zipEntry.push(new Uint8Array(), true);
      }
      await outputBackpressure;
    }
    zip.end();
    await completed;
  } catch (error) {
    zip.terminate();
    output.destroy(error);
    await completed.catch(() => {});
    await fs.rm(zipArchivePath, { force: true });
    throw error;
  }
}

export async function createReproduciblePortableArchives({
  stagingRoot,
  outputDir,
  archivePath,
  zipArchivePath = null
}) {
  const entries = await collectArchiveEntries(stagingRoot, outputDir);
  await createTarGzip(archivePath, entries);
  if (zipArchivePath) await createZipArchive(zipArchivePath, entries);
}
