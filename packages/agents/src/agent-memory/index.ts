import { canonicalJson as stableJson } from "@meshrix/contracts/serialization/canonical-json";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  appendJsonLine,
  atomicWriteFile,
  queueStateMutation,
  stateFileKey,
  waitForStateIdle
} from "@meshrix/foundation/storage/state-coordinator";

export const AGENT_MEMORY_PROTOCOL_VERSION: any = "v0.0.1:agent:memory-1";

const SENSITIVE_KEY_PATTERN: any =
  /token|secret|password|passwd|authorization|cookie|api[-_]?key|client[-_]?secret|csrf/i;
const SENSITIVE_TEXT_PATTERN: any =
  /(Bearer\s+[A-Za-z0-9._~+/=-]+|sk-[A-Za-z0-9._-]+|xox[baprs]-[A-Za-z0-9-]+|(?:(?:api[-_]?key|token|secret|password)\s*[:=]\s*)[^\s"',;]+)/gi;
const ABSOLUTE_PATH_PATTERN: any =
  /(?:[A-Za-z]:\\[^\s"'<>]+|\/(?:Users|home|var|tmp|private|Volumes|opt|etc)\/[^\s"'<>]+)/g;
const DEFAULT_MAX_STORAGE_BYTES: any = 16 * 1024 * 1024;
const DEFAULT_MAX_SCAN_BYTES: any = 16 * 1024 * 1024;
const DEFAULT_MAX_RECORD_BYTES: any = 256 * 1024;
const DEFAULT_MAX_STORED_RECORDS: any = 1000;
const MAX_STRING_CHARS: any = 32 * 1024;
const MAX_ARRAY_ITEMS: any = 128;
const MAX_OBJECT_KEYS: any = 128;

function nowIso() : any {
  return new Date().toISOString();
}


function hashValue(value?: any, length: any = 32) : any {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, length);
}

function redactText(value?: any) : any {
  const text: any = String(value ?? "")
    .replace(SENSITIVE_TEXT_PATTERN, (match?: any) : any => {
      const prefix: any = match.match(/^\s*(api[-_]?key|token|secret|password)\s*[:=]/i)?.[0] || "";
      return prefix ? `${prefix}<redacted>` : "<redacted-secret>";
    })
    .replace(ABSOLUTE_PATH_PATTERN, "<redacted-path>");
  return text.length <= MAX_STRING_CHARS
    ? text
    : `${text.slice(0, MAX_STRING_CHARS)}<truncated>`;
}

export function redactAgentMemoryValue(value?: any, depth: any = 0) : any {
  if (depth > 8) {
    return "<redacted-depth>";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactText(value);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return {
      redacted: true,
      reason: "buffer",
      byteLength: value.length,
      sha256: crypto.createHash("sha256").update(value).digest("hex")
    };
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS)
      .map((item?: any) : any => redactAgentMemoryValue(item, depth + 1));
  }
  const output: Record<string, any> = {};
  for (const [key, nested] of (Object.entries(value) as [string, any][]).slice(0, MAX_OBJECT_KEYS)) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "<redacted>"
      : redactAgentMemoryValue(nested, depth + 1);
  }
  return output;
}

function positiveInteger(value?: any, fallback?: any, maximum: any = Number.MAX_SAFE_INTEGER) : any {
  const parsed: any = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function parseJsonLines(text?: any) : any {
  const records: any[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const trimmed: any = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A malformed historical line must not hide newer valid memory records.
    }
  }
  return records;
}

async function readJsonlTail(filePath?: any, limit: any = 50, maxScanBytes: any = DEFAULT_MAX_SCAN_BYTES) : Promise<any> {
  let handle: any = null;
  try {
    handle = await fs.open(filePath, "r");
    const stat: any = await handle.stat();
    const scanBytes: any = Math.min(
      stat.size,
      positiveInteger(maxScanBytes, DEFAULT_MAX_SCAN_BYTES, 64 * 1024 * 1024)
    );
    const start: any = Math.max(0, stat.size - scanBytes);
    const buffer: any = Buffer.allocUnsafe(scanBytes);
    if (scanBytes > 0) await handle.read(buffer, 0, scanBytes, start);
    let content: any = buffer.toString("utf8");
    if (start > 0) {
      const firstLineBreak: any = content.indexOf("\n");
      content = firstLineBreak >= 0 ? content.slice(firstLineBreak + 1) : "";
    }
    return parseJsonLines(content)
      .slice(-Math.max(1, Math.min(Number(limit || 50), 1000)));
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() : any => null);
  }
}

function recordTimestamp(record: Record<string, any> = {}) : any {
  const time: any = Date.parse(record.createdAt || record.updatedAt || "");
  return Number.isFinite(time) ? time : 0;
}

function normalizeSessionRecord(entry: Record<string, any> = {}) : any {
  return {
    protocolVersion: AGENT_MEMORY_PROTOCOL_VERSION,
    memoryId: entry.memoryId || `agent_memory_${crypto.randomUUID()}`,
    sessionId: String(entry.sessionId || ""),
    profileId: String(entry.profileId || ""),
    boundaryId: String(entry.boundaryId || ""),
    sourceHash: String(entry.sourceHash || ""),
    summaryChecksum: entry.summaryChecksum || hashValue(entry.summary || ""),
    summary: redactText(entry.summary || ""),
    structured: redactAgentMemoryValue(entry.structured || {}),
    sourceRange: redactAgentMemoryValue(entry.sourceRange || {}),
    createdAt: entry.createdAt || nowIso(),
    status: entry.status || "active",
    sourceProtocolVersion: entry.protocolVersion || entry.sourceProtocolVersion || ""
  };
}

function fitSessionRecord(record?: any, maxRecordBytes?: any) : any {
  const serialized: any = JSON.stringify(record);
  const byteLength: any = Buffer.byteLength(serialized);
  if (byteLength <= maxRecordBytes) return record;
  const structured: any = record.structured;
  const sourceRange: any = record.sourceRange;
  const compacted: Record<string, any> = {
    ...record,
    summary: redactText(record.summary).slice(0, Math.min(MAX_STRING_CHARS, 16 * 1024)),
    structured: {
      truncated: true,
      originalBytes: Buffer.byteLength(JSON.stringify(structured)),
      sha256: hashValue(structured)
    },
    sourceRange: {
      truncated: true,
      originalBytes: Buffer.byteLength(JSON.stringify(sourceRange)),
      sha256: hashValue(sourceRange)
    }
  };
  while (Buffer.byteLength(JSON.stringify(compacted)) > maxRecordBytes && compacted.summary.length > 256) {
    compacted.summary = compacted.summary.slice(0, Math.max(256, Math.floor(compacted.summary.length / 2)));
  }
  return compacted;
}

export function createAgentMemory({
  userDataPath,
  rootPath = "",
  sessionMemoryPath = "",
  maxStorageBytes = DEFAULT_MAX_STORAGE_BYTES,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES,
  maxRecordBytes = DEFAULT_MAX_RECORD_BYTES,
  maxStoredRecords = DEFAULT_MAX_STORED_RECORDS
}: Record<string, any> = {}) : any {
  if (!userDataPath && !rootPath && !sessionMemoryPath) {
    throw new Error("agent_memory_user_data_path_required");
  }
  const resolvedRootPath: any = rootPath || path.join(userDataPath, "agent-memory");
  const resolvedSessionMemoryPath: any = sessionMemoryPath || path.join(resolvedRootPath, "session-memory.jsonl");
  const storageByteLimit: any = positiveInteger(maxStorageBytes, DEFAULT_MAX_STORAGE_BYTES, 64 * 1024 * 1024);
  const scanByteLimit: any = Math.max(
    storageByteLimit,
    positiveInteger(maxScanBytes, DEFAULT_MAX_SCAN_BYTES, 64 * 1024 * 1024)
  );
  const recordByteLimit: any = Math.min(
    storageByteLimit,
    positiveInteger(maxRecordBytes, DEFAULT_MAX_RECORD_BYTES, 4 * 1024 * 1024)
  );
  const storedRecordLimit: any = positiveInteger(maxStoredRecords, DEFAULT_MAX_STORED_RECORDS, 10_000);

  async function compactSessionMemoryIfNeeded() : Promise<any> {
    const stat: any = await fs.stat(resolvedSessionMemoryPath).catch(() : any => null);
    if (!stat || stat.size <= storageByteLimit) return;
    const records: any = await readJsonlTail(
      resolvedSessionMemoryPath,
      storedRecordLimit,
      scanByteLimit + recordByteLimit
    );
    const targetBytes: any = Math.max(recordByteLimit, Math.floor(storageByteLimit * 0.75));
    let retained: any = records.slice(-storedRecordLimit);
    let content: any = retained.map((record?: any) : any => JSON.stringify(record)).join("\n");
    if (content) content += "\n";
    while (retained.length > 1 && Buffer.byteLength(content) > targetBytes) {
      retained = retained.slice(1);
      content = `${retained.map((record?: any) : any => JSON.stringify(record)).join("\n")}\n`;
    }
    await atomicWriteFile(resolvedSessionMemoryPath, content, "utf8");
  }

  async function readSessionRecords(limit: any = 50) : Promise<any> {
    await waitForStateIdle(stateFileKey(resolvedSessionMemoryPath));
    const safeLimit: any = Math.max(1, Math.min(Number(limit || 50), 1000));
    const records: any[] = [];
    const pathRecords: any = await readJsonlTail(resolvedSessionMemoryPath, safeLimit, scanByteLimit);
    pathRecords.forEach((record?: any, index?: any) : any => {
      records.push({
        ...record,
        storagePath: resolvedSessionMemoryPath,
        __lineIndex: index
      });
    });
    return records
      .sort((left?: any, right?: any) : any => {
        const timestampDelta: any = recordTimestamp(right) - recordTimestamp(left);
        if (timestampDelta !== 0) {
          return timestampDelta;
        }
        return Number(right.__lineIndex || 0) - Number(left.__lineIndex || 0);
      })
      .slice(0, safeLimit)
      .map(({ __lineIndex, ...record }: Record<string, any>) : any => record);
  }

  async function latestSessionMemory({ sessionId = "", profileId = "", sourceHash = "" }: Record<string, any> = {}) : Promise<any> {
    const records: any = await readSessionRecords(500);
    for (const record of records) {
      const baseMatches: any =
        (!sessionId || record.sessionId === sessionId) &&
        (!profileId || !record.profileId || record.profileId === profileId);
      if (!baseMatches) {
        continue;
      }
      if (record.status === "cleared") {
        return null;
      }
      if (sourceHash && record.sourceHash !== sourceHash) {
        continue;
      }
      return record;
    }
    return null;
  }

  async function appendSessionMemory(entry: Record<string, any> = {}) : Promise<any> {
    const record: any = fitSessionRecord(normalizeSessionRecord(entry), recordByteLimit);
    await queueStateMutation(stateFileKey(resolvedSessionMemoryPath), async () : Promise<any> => {
      await appendJsonLine(resolvedSessionMemoryPath, record);
      await compactSessionMemoryIfNeeded();
    });
    return record;
  }

  async function listSessionMemory(input: Record<string, any> = {}) : Promise<any> {
    const records: any = await readSessionRecords(input.limit || 50);
    return {
      protocolVersion: AGENT_MEMORY_PROTOCOL_VERSION,
      rootPath: resolvedRootPath,
      path: resolvedSessionMemoryPath,
      records: records.filter((record?: any) : any =>
        (!input.sessionId || record.sessionId === input.sessionId) &&
        (!input.profileId || record.profileId === input.profileId)
      )
    };
  }

  async function clearSessionMemory(input: Record<string, any> = {}) : Promise<any> {
    const record: any = fitSessionRecord(normalizeSessionRecord({
      memoryId: `agent_memory_clear_${crypto.randomUUID()}`,
      sessionId: input.sessionId || "",
      profileId: input.profileId || "",
      status: "cleared",
      createdAt: nowIso(),
      summary: "",
      structured: {
        reason: input.reason || "manual_clear"
      }
    }), recordByteLimit);
    await queueStateMutation(stateFileKey(resolvedSessionMemoryPath), async () : Promise<any> => {
      await appendJsonLine(resolvedSessionMemoryPath, record);
      await compactSessionMemoryIfNeeded();
    });
    return {
      protocolVersion: AGENT_MEMORY_PROTOCOL_VERSION,
      ok: true,
      record
    };
  }

  return Object.freeze({
    protocolVersion: AGENT_MEMORY_PROTOCOL_VERSION,
    rootPath: resolvedRootPath,
    sessionMemoryPath: resolvedSessionMemoryPath,
    latestSessionMemory,
    appendSessionMemory,
    listSessionMemory,
    clearSessionMemory
  });
}

export default createAgentMemory;
