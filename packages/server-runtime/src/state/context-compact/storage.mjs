import fs from "node:fs/promises";
import { atomicWriteJson } from "#meshrix/state-coordinator";
import {
  appendBoundedJsonLine,
  readJsonlTail as readBoundedJsonlTail
} from "#meshrix/foundation/storage/bounded-jsonl";
import { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.mjs";
import { nowIso } from "./validation.mjs";

const CONTEXT_COMPACTION_RECORDS_MAX_BYTES = 16 * 1024 * 1024;

export function publicRecordFromResult(result = {}) {
  return {
    protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
    recordId: result.recordId,
    boundaryId: result.boundary?.boundaryId || "",
    sessionId: result.sessionId || "",
    profileId: result.profileId || "",
    source: result.source || "",
    status: result.status || "",
    triggerReason: result.triggerReason || "",
    strategy: result.strategy || null,
    executionMode: result.executionMode || "",
    degraded: result.degraded === true,
    degradedReasons: result.degradedReasons || [],
    circuitBreaker: result.circuitBreaker || null,
    preprocessingEvents: result.preprocessingEvents || [],
    cutPoint: result.cutPoint || null,
    tokenReport: result.tokenReport || null,
    qualityReport: result.qualityReport || null,
    boundary: result.boundary || null,
    createdAt: result.createdAt || nowIso()
  };
}

export async function appendJsonl(filePath, value) {
  await appendBoundedJsonLine(filePath, value, {
    maxBytes: CONTEXT_COMPACTION_RECORDS_MAX_BYTES,
    retainedBytes: CONTEXT_COMPACTION_RECORDS_MAX_BYTES / 2
  });
}

export async function readJsonlTail(filePath, limit = 50) {
  return readBoundedJsonlTail(filePath, {
    limit,
    maxScanBytes: CONTEXT_COMPACTION_RECORDS_MAX_BYTES / 2,
    reverse: true
  });
}

export async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(filePath, value) {
  await atomicWriteJson(filePath, value, { trailingNewline: false });
}
