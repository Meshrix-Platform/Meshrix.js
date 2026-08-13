import fs from "node:fs/promises";
import {
  appendJsonLine,
  atomicWriteFile,
  queueStateMutation,
  stateFileKey,
  waitForStateIdle
} from "./state-coordinator.ts";

const DEFAULT_MAX_BYTES: any = 16 * 1024 * 1024;
const DEFAULT_RETAINED_BYTES: any = 8 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES: any = 2 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES: any = 8 * 1024 * 1024;
const NO_OVERFLOW_REPLACEMENT: any = Symbol("no-overflow-replacement");

function positiveInteger(value?: any, fallback?: any, maximum: any = Number.MAX_SAFE_INTEGER) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

async function readRecentCompleteLines(filePath?: any, maxScanBytes?: any) : Promise<any> {
  let handle: any = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat: any = await handle.stat();
    const length: any = Math.min(stat.size, maxScanBytes);
    const start: any = Math.max(0, stat.size - length);
    const buffer: any = Buffer.allocUnsafe(length);
    let offset: any = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let content: any = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstLineBreak: any = content.indexOf("\n");
      content = firstLineBreak >= 0 ? content.slice(firstLineBreak + 1) : "";
    }
    return content.split(/\r?\n/).map((line?: any) : any => line.trim()).filter(Boolean);
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  } finally {
    await handle?.close().catch(() : any => null);
  }
}

export async function readJsonlTail(filePath?: any, {
  limit = 50,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  reverse = false,
  ignoreMalformed = false
}: Record<string, any> = {}) : Promise<any> {
  await waitForStateIdle(stateFileKey(filePath));
  const safeLimit: any = positiveInteger(limit, 50, 10_000);
  const lines: any = await readRecentCompleteLines(
    filePath,
    positiveInteger(maxScanBytes, DEFAULT_MAX_SCAN_BYTES, 64 * 1024 * 1024)
  );
  const records: any[] = [];
  for (const line of lines.slice(-safeLimit)) {
    try {
      records.push(JSON.parse(line));
    } catch (error: any) {
      if (!ignoreMalformed) throw error;
    }
  }
  return reverse ? records.reverse() : records;
}

export async function appendBoundedJsonLine(filePath?: any, value?: any, {
  maxBytes = DEFAULT_MAX_BYTES,
  retainedBytes = DEFAULT_RETAINED_BYTES,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  overflowReplacement = NO_OVERFLOW_REPLACEMENT
}: Record<string, any> = {}) : Promise<any> {
  const byteLimit: any = positiveInteger(maxBytes, DEFAULT_MAX_BYTES, 1024 * 1024 * 1024);
  const retainedByteLimit: any = Math.min(
    byteLimit,
    positiveInteger(retainedBytes, DEFAULT_RETAINED_BYTES, byteLimit)
  );
  const recordByteLimit: any = Math.min(
    byteLimit,
    positiveInteger(maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 64 * 1024 * 1024)
  );
  const serialized: any = JSON.stringify(value);
  const recordBytes: any = Buffer.byteLength(serialized);
  const recordLineBytes: any = recordBytes + 1;
  if (recordBytes > recordByteLimit) {
    const error: Error & Record<string, any> = new Error("JSONL record exceeds the configured persistence limit.");
    error.code = "BOUNDED_JSONL_RECORD_TOO_LARGE";
    error.recordBytes = recordBytes;
    error.maxRecordBytes = recordByteLimit;
    throw error;
  }

  return queueStateMutation(stateFileKey(filePath), async () : Promise<any> => {
    if (overflowReplacement !== NO_OVERFLOW_REPLACEMENT) {
      let currentBytes: any = 0;
      try {
        currentBytes = (await fs.stat(filePath)).size;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      if (currentBytes + recordLineBytes <= byteLimit) {
        await appendJsonLine(filePath, value);
        return { replaced: false, value };
      }
      const replacementContent: any = `${JSON.stringify(overflowReplacement)}\n`;
      const replacementBytes: any = Buffer.byteLength(replacementContent);
      if (replacementBytes > byteLimit) {
        const error: Error & Record<string, any> = new Error(
          "JSONL replacement exceeds the configured persistence limit."
        );
        error.code = "BOUNDED_JSONL_REPLACEMENT_TOO_LARGE";
        error.replacementBytes = replacementBytes;
        error.maxBytes = byteLimit;
        throw error;
      }
      await atomicWriteFile(filePath, replacementContent, "utf8");
      return { replaced: true, value };
    }
    await appendJsonLine(filePath, value);
    const stat: any = await fs.stat(filePath);
    if (stat.size <= byteLimit) return value;

    const lines: any = await readRecentCompleteLines(filePath, retainedByteLimit + recordByteLimit);
    let retained: any = lines;
    let content: any = retained.length ? `${retained.join("\n")}\n` : `${serialized}\n`;
    while (retained.length > 1 && Buffer.byteLength(content) > retainedByteLimit) {
      retained = retained.slice(1);
      content = `${retained.join("\n")}\n`;
    }
    await atomicWriteFile(filePath, content, "utf8");
    return value;
  });
}
