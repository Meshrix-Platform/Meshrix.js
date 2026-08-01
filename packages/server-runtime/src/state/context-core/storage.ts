import fs from "node:fs/promises";
import { atomicWriteJson } from "#meshrix/state-coordinator";
import { appendBoundedJsonLine, readJsonlTail } from "#meshrix/foundation/storage/bounded-jsonl";

const CONTEXT_RECORDS_MAX_BYTES: any = 16 * 1024 * 1024;

export function createContextCoreStorage({
  profilesPath,
  buildRecordsPath,
  evaluationRunsPath,
  protocolVersion,
  normalizeProfiles
}: Record<string, any>) : any {
  async function readProfiles() : Promise<any> {
    try {
      const parsed: any = JSON.parse(await fs.readFile(profilesPath, "utf8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.profiles)) {
        throw new Error("context_profiles_file_invalid");
      }
      return normalizeProfiles(parsed.profiles);
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeProfiles(profiles?: any) : Promise<any> {
    const normalized: any = normalizeProfiles(profiles);
    await atomicWriteJson(profilesPath, {
      protocolVersion,
      updatedAt: new Date().toISOString(),
      profiles: normalized
    });
    return normalized;
  }

  async function listProfiles() : Promise<any> {
    const profiles: any = await readProfiles();
    return {
      protocolVersion,
      profiles,
      path: profilesPath
    };
  }

  async function saveProfiles(input: Record<string, any> = {}) : Promise<any> {
    if (!Array.isArray(input.profiles)) {
      throw new Error("context_profiles_required");
    }
    const profiles: any = await writeProfiles(input.profiles);
    return {
      protocolVersion,
      profiles,
      path: profilesPath
    };
  }

  async function listBuildRecords(input: Record<string, any> = {}) : Promise<any> {
    const records: any = await readJsonlTail(buildRecordsPath, {
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

  async function writeBuildRecord(record?: any) : Promise<any> {
    await appendBoundedJsonLine(buildRecordsPath, record, {
      maxBytes: CONTEXT_RECORDS_MAX_BYTES,
      retainedBytes: CONTEXT_RECORDS_MAX_BYTES / 2
    });
    return record;
  }

  async function appendEvaluationRun(run?: any) : Promise<any> {
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
