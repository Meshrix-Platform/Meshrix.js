import fs from "node:fs/promises";
import { atomicWriteJson } from "#meshrix/state-coordinator";
import {
  appendBoundedJsonLine,
  readJsonlTail,
} from "#meshrix/foundation/storage/bounded-jsonl";
import type {
  ContextProfile,
  ContextStorage,
  ContextStorageOptions,
  RuntimeRecord,
} from "./types.ts";

const CONTEXT_RECORDS_MAX_BYTES = 16 * 1024 * 1024;

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code || "")
    : "";
}

export function createContextCoreStorage({
  profilesPath,
  buildRecordsPath,
  evaluationRunsPath,
  protocolVersion,
  normalizeProfiles,
}: ContextStorageOptions): ContextStorage {
  async function readProfiles(): Promise<ContextProfile[]> {
    try {
      const parsed: unknown = JSON.parse(
        await fs.readFile(profilesPath, "utf8"),
      );
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !("profiles" in parsed) ||
        !Array.isArray(parsed.profiles)
      ) {
        throw new Error("context_profiles_file_invalid");
      }
      return normalizeProfiles(parsed.profiles);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
  }

  async function writeProfiles(profiles?: unknown): Promise<ContextProfile[]> {
    const normalized = normalizeProfiles(profiles);
    await atomicWriteJson(profilesPath, {
      protocolVersion,
      updatedAt: new Date().toISOString(),
      profiles: normalized,
    });
    return normalized;
  }

  async function listProfiles() {
    const profiles = await readProfiles();
    return {
      protocolVersion,
      profiles,
      path: profilesPath,
    };
  }

  async function saveProfiles(input: RuntimeRecord = {}) {
    if (!Array.isArray(input.profiles)) {
      throw new Error("context_profiles_required");
    }
    const profiles = await writeProfiles(input.profiles);
    return {
      protocolVersion,
      profiles,
      path: profilesPath,
    };
  }

  async function listBuildRecords(input: RuntimeRecord = {}) {
    const records = await readJsonlTail(buildRecordsPath, {
      limit: Number(input.limit) || 50,
      maxScanBytes: CONTEXT_RECORDS_MAX_BYTES / 2,
      reverse: true,
    });
    return {
      protocolVersion,
      path: buildRecordsPath,
      records,
    };
  }

  async function writeBuildRecord<T>(record: T): Promise<T> {
    await appendBoundedJsonLine(buildRecordsPath, record, {
      maxBytes: CONTEXT_RECORDS_MAX_BYTES,
      retainedBytes: CONTEXT_RECORDS_MAX_BYTES / 2,
    });
    return record;
  }

  async function appendEvaluationRun<T>(run: T): Promise<T> {
    await appendBoundedJsonLine(evaluationRunsPath, run, {
      maxBytes: CONTEXT_RECORDS_MAX_BYTES,
      retainedBytes: CONTEXT_RECORDS_MAX_BYTES / 2,
    });
    return run;
  }

  return {
    readProfiles,
    writeProfiles,
    listProfiles,
    saveProfiles,
    listBuildRecords,
    writeBuildRecord,
    appendEvaluationRun,
  };
}
