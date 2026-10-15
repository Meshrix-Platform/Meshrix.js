import fs from "node:fs/promises";
import {
  appendJsonLine,
  atomicWriteFile,
  queueStateMutation,
  stateFileKey,
  truncateTornJsonLineTail,
  waitForStateIdle
} from "./state-coordinator.ts";

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_RETAINED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES = 8 * 1024 * 1024;
const NO_OVERFLOW_REPLACEMENT = Symbol("no-overflow-replacement");

interface JsonlTailOptions {
  limit?: number;
  maxScanBytes?: number;
  reverse?: boolean;
  ignoreMalformed?: boolean;
  healTornTail?: boolean;
  filter?: (value: unknown) => boolean;
  waitForIdle?: boolean;
}

interface BoundedJsonlOptions {
  maxBytes?: number;
  retainedBytes?: number;
  maxRecordBytes?: number;
  overflowReplacement?: unknown;
}

export interface BoundedJsonlReplacementResult<T> {
  replaced: boolean;
  value: T;
}

type BoundedJsonlError = Error & {
  code: string;
  recordBytes?: number;
  replacementBytes?: number;
  maxRecordBytes?: number;
  maxBytes?: number;
};

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String(error.code || "");
}

function positiveInteger(value: unknown, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

async function readRecentCompleteLines(
  filePath: string,
  maxScanBytes: number,
  maxLines = Number.POSITIVE_INFINITY,
  healTornTail = true,
  acceptLine?: (line: string) => boolean
): Promise<string[]> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(filePath, "r");
    let fileSize = Number((await handle.stat()).size || 0);
    let position = fileSize;
    let scannedBytes = 0;
    let suffix = Buffer.alloc(0);
    const reverseLines: string[] = [];
    let checkedTail = false;

    while (position > 0 && scannedBytes < maxScanBytes && reverseLines.length < maxLines) {
      const length = Math.min(64 * 1024, maxScanBytes - scannedBytes, position);
      const chunkStart = position - length;
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, chunkStart + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset === 0) break;

      let chunk = buffer.subarray(0, offset);
      if (!checkedTail) {
        checkedTail = true;
        if (chunkStart + offset === fileSize && chunk.at(-1) !== 0x0a) {
          if (healTornTail) {
            await queueStateMutation(stateFileKey(filePath), async (): Promise<void> => {
              await truncateTornJsonLineTail(filePath);
            });
            fileSize = Number((await handle.stat()).size || 0);
            position = fileSize;
            scannedBytes = 0;
            suffix = Buffer.alloc(0);
            reverseLines.length = 0;
            checkedTail = false;
            continue;
          }
          const lastCompleteBoundary = chunk.lastIndexOf(0x0a);
          chunk = lastCompleteBoundary < 0 ? Buffer.alloc(0) : chunk.subarray(0, lastCompleteBoundary + 1);
          suffix = Buffer.alloc(0);
        }
      }

      const combined = suffix.length > 0
        ? Buffer.concat([chunk, suffix])
        : chunk;
      let right = combined.length;
      for (let index = combined.length - 1; index >= 0; index -= 1) {
        if (combined[index] !== 0x0a) continue;
        const line = combined.subarray(index + 1, right).toString("utf8").trim();
        if (line && (!acceptLine || acceptLine(line))) reverseLines.push(line);
        right = index;
        if (reverseLines.length >= maxLines) break;
      }
      if (reverseLines.length >= maxLines) break;

      const prefix = combined.subarray(0, right);
      position = chunkStart;
      scannedBytes += offset;
      if (position === 0) {
        const firstLine = prefix.toString("utf8").trim();
        if (firstLine && (!acceptLine || acceptLine(firstLine))) reverseLines.push(firstLine);
        break;
      }
      suffix = prefix;
    }

    return reverseLines.reverse();
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close().catch(() => null);
  }
}

export async function readJsonlTail(filePath: string, {
  limit = 50,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  reverse = false,
  ignoreMalformed = false,
  healTornTail = true,
  filter,
  waitForIdle = true
}: JsonlTailOptions = {}): Promise<unknown[]> {
  if (waitForIdle) await waitForStateIdle(stateFileKey(filePath));
  const safeLimit = positiveInteger(limit, 50, 10_000);
  const parsedRecords: unknown[] = [];
  const acceptLine = ignoreMalformed || filter
    ? (line: string): boolean => {
      try {
        const value = JSON.parse(line) as unknown;
        const accepted = filter ? filter(value) : true;
        if (accepted) parsedRecords.push(value);
        return accepted;
      } catch (error: unknown) {
        if (!ignoreMalformed) throw error;
        return false;
      }
    }
    : undefined;
  const lines = await readRecentCompleteLines(
    filePath,
    positiveInteger(maxScanBytes, DEFAULT_MAX_SCAN_BYTES, 64 * 1024 * 1024),
    safeLimit,
    healTornTail,
    acceptLine
  );
  if (acceptLine) {
    parsedRecords.reverse();
    return reverse ? parsedRecords.reverse() : parsedRecords;
  }
  const records: unknown[] = [];
  for (const line of lines) {
    try {
      const record = JSON.parse(line) as unknown;
      records.push(record);
    } catch (error: unknown) {
      if (!ignoreMalformed) throw error;
    }
  }
  return reverse ? records.reverse() : records;
}

export async function appendBoundedJsonLine<T>(filePath: string, value: T, {
  maxBytes = DEFAULT_MAX_BYTES,
  retainedBytes = DEFAULT_RETAINED_BYTES,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  overflowReplacement = NO_OVERFLOW_REPLACEMENT
}: BoundedJsonlOptions = {}): Promise<T | BoundedJsonlReplacementResult<T>> {
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
  if (serialized === undefined) throw new TypeError("JSONL record is not serializable.");
  const recordBytes = Buffer.byteLength(serialized);
  const recordLineBytes = recordBytes + 1;
  if (recordBytes > recordByteLimit) {
    const error = new Error("JSONL record exceeds the configured persistence limit.") as BoundedJsonlError;
    error.code = "BOUNDED_JSONL_RECORD_TOO_LARGE";
    error.recordBytes = recordBytes;
    error.maxRecordBytes = recordByteLimit;
    throw error;
  }

  return queueStateMutation(stateFileKey(filePath), async (): Promise<T | BoundedJsonlReplacementResult<T>> => {
    if (overflowReplacement !== NO_OVERFLOW_REPLACEMENT) {
      let currentBytes = 0;
      try {
        currentBytes = (await fs.stat(filePath)).size;
      } catch (error: unknown) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      if (currentBytes + recordLineBytes <= byteLimit) {
        await appendJsonLine(filePath, value);
        return { replaced: false, value };
      }
      const replacementContent = `${JSON.stringify(overflowReplacement)}\n`;
      const replacementBytes = Buffer.byteLength(replacementContent);
      if (replacementBytes > byteLimit) {
        const error = new Error(
          "JSONL replacement exceeds the configured persistence limit."
        ) as BoundedJsonlError;
        error.code = "BOUNDED_JSONL_REPLACEMENT_TOO_LARGE";
        error.replacementBytes = replacementBytes;
        error.maxBytes = byteLimit;
        throw error;
      }
      await atomicWriteFile(filePath, replacementContent, "utf8");
      return { replaced: true, value };
    }
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
