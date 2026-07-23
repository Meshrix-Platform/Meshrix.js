import fs from "node:fs/promises";
import { atomicWriteJson } from "#lico/state-coordinator";
import { appendBoundedJsonLine, readJsonlTail } from "#lico/foundation/storage/bounded-jsonl";

const CONTEXT_RECORDS_MAX_BYTES = 16 * 1024 * 1024;

export function createContextCoreStorage({
  profilesPath,
  buildRecordsPath,
  evaluationRunsPath,
  protocolVersion,
  normalizeProfiles
}) {
  async function readProfiles() {
    try {
      const parsed = JSON.parse(await fs.readFile(profilesPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.profiles)) {
        throw new Error("context_profiles_file_invalid");
      }
      return normalizeProfiles(parsed.profiles);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeProfiles(profiles) {
    const normalized = normalizeProfiles(profiles);
    await atomicWriteJson(profilesPath, {
      protocolVersion,
      updatedAt: new Date().toISOString(),
      profiles: normalized
    });
    return normalized;
  }

  async function listProfiles() {
    const profiles = await readProfiles();
    return {
      protocolVersion,
      profiles,
      path: profilesPath
    };
  }

  async function saveProfiles(input = {}) {
    if (!Array.isArray(input.profiles)) {
      throw new Error("context_profiles_required");
    }
    const profiles = await writeProfiles(input.profiles);
    return {
      protocolVersion,
      profiles,
      path: profilesPath
    };
  }

  async function listBuildRecords(input = {}) {
    const records = await readJsonlTail(buildRecordsPath, {
      limit: input.limit || 50,
      maxScanBytes: CONTEXT_RECORDS_MAX_BYTES / 2,
      reverse: true
    });
    return {
      protocolVersion,
      path: buildRecordsPath,
      records
    };
  }

  async function writeBuildRecord(record) {
    await appendBoundedJsonLine(buildRecordsPath, record, {
      maxBytes: CONTEXT_RECORDS_MAX_BYTES,
      retainedBytes: CONTEXT_RECORDS_MAX_BYTES / 2
    });
    return record;
  }

  async function appendEvaluationRun(run) {
    await appendBoundedJsonLine(evaluationRunsPath, run, {
      maxBytes: CONTEXT_RECORDS_MAX_BYTES,
      retainedBytes: CONTEXT_RECORDS_MAX_BYTES / 2
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
    appendEvaluationRun
  };
}
