import fs from "node:fs/promises";
import { atomicWriteJson } from "#meshrix/state-coordinator";
import {
  appendBoundedJsonLine,
  readJsonlTail as readBoundedJsonlTail
} from "#meshrix/foundation/storage/bounded-jsonl";
import { CONTEXT_COMPACTION_PROTOCOL_VERSION } from "./constants.ts";
import { asObject, nowIso } from "./validation.ts";

const CONTEXT_COMPACTION_RECORDS_MAX_BYTES = 16 * 1024 * 1024;

export interface PublicCompactionRecord {
  protocolVersion: string;
  recordId: unknown;
  boundaryId: string;
  sessionId: string;
  profileId: string;
  source: string;
  status: string;
  triggerReason: string;
  strategy: unknown;
  executionMode: string;
  degraded: boolean;
  degradedReasons: unknown;
  circuitBreaker: unknown;
  preprocessingEvents: unknown;
  cutPoint: unknown;
  tokenReport: unknown;
  qualityReport: unknown;
  boundary: unknown;
  createdAt: string;
}

export function publicRecordFromResult(result: Record<string, unknown> = {}) : PublicCompactionRecord {
  return {
    protocolVersion: CONTEXT_COMPACTION_PROTOCOL_VERSION,
    recordId: result.recordId,
    boundaryId: String(asObject(result.boundary).boundaryId || ""),
    sessionId: String(result.sessionId || ""),
    profileId: String(result.profileId || ""),
    source: String(result.source || ""),
    status: String(result.status || ""),
    triggerReason: String(result.triggerReason || ""),
    strategy: result.strategy || null,
    executionMode: String(result.executionMode || ""),
    degraded: result.degraded === true,
    degradedReasons: result.degradedReasons || [],
    circuitBreaker: result.circuitBreaker || null,
    preprocessingEvents: result.preprocessingEvents || [],
    cutPoint: result.cutPoint || null,
    tokenReport: result.tokenReport || null,
    qualityReport: result.qualityReport || null,
    boundary: result.boundary || null,
    createdAt: String(result.createdAt || nowIso())
  };
}

export async function appendJsonl(filePath: string, value: unknown) : Promise<void> {
  await appendBoundedJsonLine(filePath, value, {
    maxBytes: CONTEXT_COMPACTION_RECORDS_MAX_BYTES,
    retainedBytes: CONTEXT_COMPACTION_RECORDS_MAX_BYTES / 2
  });
}

export async function readJsonlTail(filePath: string, limit = 50) : Promise<unknown[]> {
  return readBoundedJsonlTail(filePath, {
    limit,
    maxScanBytes: CONTEXT_COMPACTION_RECORDS_MAX_BYTES / 2,
    reverse: true
  });
}

export async function readJson(filePath: string, fallback: Record<string, unknown> = {}) : Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error: unknown) {
    if (commandErrorCode(error) === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(filePath: string, value: unknown) : Promise<boolean> {
  return atomicWriteJson(filePath, value, { trailingNewline: false });
}

function commandErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String((error as { code?: unknown }).code || "");
}
