import fs from "node:fs/promises";
import {
  appendJsonLine,
  atomicWriteFile,
  queueStateMutation,
  stateFileKey,
  waitForStateIdle
} from "./state-coordinator.mjs";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETAINED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

async function readRecentCompleteLines(filePath, maxScanBytes) {
  let handle = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxScanBytes);
    const start = Math.max(0, stat.size - length);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let content = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstLineBreak = content.indexOf("\n");
      content = firstLineBreak >= 0 ? content.slice(firstLineBreak + 1) : "";
    }
    return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export async function readJsonlTail(filePath, {
  limit = 50,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  reverse = false,
  ignoreMalformed = false
} = {}) {
  await waitForStateIdle(stateFileKey(filePath));
  const safeLimit = positiveInteger(limit, 50, 10_000);
  const lines = await readRecentCompleteLines(
    filePath,
    positiveInteger(maxScanBytes, DEFAULT_MAX_SCAN_BYTES, 64 * 1024 * 1024)
  );
  const records = [];
  for (const line of lines.slice(-safeLimit)) {
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      if (!ignoreMalformed) throw error;
    }
  }
  return reverse ? records.reverse() : records;
}

export async function appendBoundedJsonLine(filePath, value, {
  maxBytes = DEFAULT_MAX_BYTES,
  retainedBytes = DEFAULT_RETAINED_BYTES,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES
} = {}) {
  const byteLimit = positiveInteger(maxBytes, DEFAULT_MAX_BYTES, 1024 * 1024 * 1024);
  const retainedByteLimit = Math.min(
    byteLimit,
    positiveInteger(retainedBytes, DEFAULT_RETAINED_BYTES, byteLimit)
  );
  const recordByteLimit = Math.min(
    byteLimit,
    positiveInteger(maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 64 * 1024 * 1024)
  );
  const serialized = JSON.stringify(value);
  const recordBytes = Buffer.byteLength(serialized);
  if (recordBytes > recordByteLimit) {
    const error = new Error("JSONL record exceeds the configured persistence limit.");
    error.code = "BOUNDED_JSONL_RECORD_TOO_LARGE";
    error.recordBytes = recordBytes;
    error.maxRecordBytes = recordByteLimit;
    throw error;
  }

  return queueStateMutation(stateFileKey(filePath), async () => {
    await appendJsonLine(filePath, value);
    const stat = await fs.stat(filePath);
    if (stat.size <= byteLimit) return value;

    const lines = await readRecentCompleteLines(filePath, retainedByteLimit + recordByteLimit);
    let retained = lines;
    let content = retained.length ? `${retained.join("\n")}\n` : `${serialized}\n`;
    while (retained.length > 1 && Buffer.byteLength(content) > retainedByteLimit) {
      retained = retained.slice(1);
      content = `${retained.join("\n")}\n`;
    }
    await atomicWriteFile(filePath, content, "utf8");
    return value;
  });
}
