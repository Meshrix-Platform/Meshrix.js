import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJsonThroughState } from "#meshrix/product-api";
import {
  getJobDirectory,
  getJobMetaPath,
  getJobPayloadPath,
  getJobResultPath
} from "./job-manager-validation.ts";

function jobPersistenceError(code?: any, jobId?: any, message?: any, cause: any = null) : any {
  const error: Error & Record<string, any> = new Error(message, cause ? { cause } : undefined);
  error.name = "JobPersistenceError";
  error.code = code;
  error.jobId = String(jobId || "");
  return error;
}

const JOB_TERMINAL_FORMAT: any = "meshrix.job-terminal";
const JOB_TERMINAL_SCHEMA: any = "job-terminal-envelope";
const MAX_JOB_METADATA_BYTES: any = 256 * 1024;
const MAX_JOB_PAYLOAD_BYTES: any = 64 * 1024 * 1024;
const MAX_JOB_RESULT_BYTES: any = 256 * 1024 * 1024;
const FILE_TOO_LARGE: any = "job_persistence_file_too_large";

function digestText(value?: any) : any {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readBoundedText(filePath?: any, maxBytes?: any) : Promise<any> {
  const handle: any = await fs.open(filePath, "r");
  try {
    const stat: any = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw Object.assign(new Error("Persisted job file exceeds its byte limit."), {
        code: FILE_TOO_LARGE
      });
    }
    const content: any = Buffer.allocUnsafe(Number(stat.size));
    let offset: any = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        offset
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const extra: any = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset);
    if (extraBytes > 0) {
      throw Object.assign(new Error("Persisted job file exceeds its byte limit."), {
        code: FILE_TOO_LARGE
      });
    }
    return content.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readPersistedJobTerminal(
  userDataPath?: any,
  jobId?: any,
  maxBytes: any = MAX_JOB_RESULT_BYTES
) : Promise<any> {
  let content: any;
  try {
    content = await readBoundedText(
      getJobResultPath(userDataPath, jobId),
      maxBytes
    );
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw jobPersistenceError(
      error?.code === FILE_TOO_LARGE
        ? "job_persistence_terminal_too_large"
        : "job_persistence_terminal_unreadable",
      jobId,
      "Persisted job terminal envelope is unreadable.",
      error
    );
  }
  let envelope: any;
  try {
    envelope = JSON.parse(content);
  } catch (error: any) {
    throw jobPersistenceError(
      "job_persistence_terminal_invalid",
      jobId,
      "Persisted job terminal envelope is not valid JSON.",
      error
    );
  }
  if (
    !envelope || typeof envelope !== "object" || Array.isArray(envelope)
    || envelope.format !== JOB_TERMINAL_FORMAT
    || envelope.schema !== JOB_TERMINAL_SCHEMA
    || !envelope.job || typeof envelope.job !== "object" || Array.isArray(envelope.job)
    || String(envelope.job.id || "") !== jobId
    || envelope.job.status !== "completed"
    || !Object.hasOwn(envelope, "result")
  ) {
    throw jobPersistenceError(
      "job_persistence_terminal_invalid",
      jobId,
      "Persisted job terminal envelope does not match its governed job identity."
    );
  }
  Object.defineProperties(envelope, {
    artifactDigest: {
      value: digestText(content),
      enumerable: false
    },
    artifactBytes: {
      value: Buffer.byteLength(content),
      enumerable: false
    }
  });
  return envelope;
}

export async function readPersistedJobMeta(
  userDataPath?: any,
  jobId?: any,
  {
    maxMetadataBytes = MAX_JOB_METADATA_BYTES,
    maxResultBytes = MAX_JOB_RESULT_BYTES
  }: Record<string, any> = {}
) : Promise<any> {
  let content: any;
  try {
    content = await readBoundedText(
      getJobMetaPath(userDataPath, jobId),
      maxMetadataBytes
    );
  } catch (error: any) {
    const terminal: any = await readPersistedJobTerminal(
      userDataPath,
      jobId,
      maxResultBytes
    );
    if (terminal && error?.code === "ENOENT") {
      await persistJobMeta(userDataPath, terminal.job);
      return terminal.job;
    }
    throw jobPersistenceError(
      error?.code === "ENOENT"
        ? "job_persistence_meta_missing"
        : error?.code === FILE_TOO_LARGE
          ? "job_persistence_meta_too_large"
          : "job_persistence_meta_unreadable",
      jobId,
      "Persisted job metadata is missing or unreadable.",
      error
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch (error: any) {
    const terminal: any = await readPersistedJobTerminal(
      userDataPath,
      jobId,
      maxResultBytes
    );
    if (terminal) {
      await persistJobMeta(userDataPath, terminal.job);
      return terminal.job;
    }
    throw jobPersistenceError(
      "job_persistence_meta_invalid",
      jobId,
      "Persisted job metadata is not valid JSON.",
      error
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const terminal: any = await readPersistedJobTerminal(
      userDataPath,
      jobId,
      maxResultBytes
    );
    if (terminal) {
      await persistJobMeta(userDataPath, terminal.job);
      return terminal.job;
    }
    throw jobPersistenceError(
      "job_persistence_meta_invalid",
      jobId,
      "Persisted job metadata must be an object."
    );
  }
  if (String(parsed.id || "") !== jobId) {
    const terminal: any = await readPersistedJobTerminal(
      userDataPath,
      jobId,
      maxResultBytes
    );
    if (terminal) {
      await persistJobMeta(userDataPath, terminal.job);
      return terminal.job;
    }
    throw jobPersistenceError(
      "job_persistence_identity_mismatch",
      jobId,
      "Persisted job metadata does not match its governed directory identity."
    );
  }

  if (parsed.status === "completed") {
    const [metaStat, terminalStat] = await Promise.all([
      fs.stat(getJobMetaPath(userDataPath, jobId)).catch(() : any => null),
      fs.stat(getJobResultPath(userDataPath, jobId)).catch(() : any => null)
    ]);
    if (!terminalStat || (metaStat && metaStat.mtimeMs >= terminalStat.mtimeMs)) {
      return parsed;
    }
  }

  const terminal: any = await readPersistedJobTerminal(
    userDataPath,
    jobId,
    maxResultBytes
  );
  if (terminal) {
    if (!isDeepStrictEqual(parsed, terminal.job)) {
      await persistJobMeta(userDataPath, terminal.job);
    }
    return terminal.job;
  }
  return parsed;
}

export async function persistJobMeta(userDataPath?: any, job?: any, projectionStore: any = null) : Promise<any> {
  projectionStore?.upsert(job);
  const jobDirectory: any = getJobDirectory(userDataPath, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  await atomicWriteJsonThroughState(getJobMetaPath(userDataPath, job.id), job, {
    trailingNewline: false,
    ignoreMissingParent: true,
    kind: "jobs.meta.write",
    metadata: { jobId: job.id }
  });
}

export async function persistJobTerminal(
  userDataPath?: any,
  job?: any,
  result?: any,
  projectionStore: any = null
) : Promise<any> {
  if (!job?.id || job.status !== "completed") {
    throw jobPersistenceError(
      "job_persistence_terminal_invalid",
      job?.id,
      "Only a completed job can commit a terminal result."
    );
  }
  const jobDirectory: any = getJobDirectory(userDataPath, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  const envelope: Record<string, any> = {
    format: JOB_TERMINAL_FORMAT,
    schema: JOB_TERMINAL_SCHEMA,
    job,
    result
  };
  const serialized: any = JSON.stringify(envelope, null, 2);
  const artifact: any = projectionStore?.beginArtifact({
    jobId: job.id,
    kind: "result",
    finalRef: `jobs/${job.id}/result.json`,
    digest: digestText(serialized),
    byteSize: Buffer.byteLength(serialized),
    job
  });
  let artifactPublished: any = false;
  try {
    await atomicWriteJsonThroughState(getJobResultPath(userDataPath, job.id), envelope, {
      trailingNewline: false,
      ignoreMissingParent: true,
      kind: "jobs.terminal.write",
      metadata: { jobId: job.id }
    });
    if (artifact) {
      projectionStore.publishArtifact(artifact.journalId);
      artifactPublished = true;
    }
    await persistJobMeta(userDataPath, job, projectionStore);
    if (artifact) projectionStore.settleArtifact(artifact.journalId);
  } catch (error: any) {
    if (artifact && !artifactPublished) {
      projectionStore.abortArtifact(artifact.journalId);
    }
    throw error;
  }
}

export async function loadJobResult(userDataPath?: any, jobId?: any, projectionStore: any = null) : Promise<any> {
  const terminal: any = await readPersistedJobTerminal(
    userDataPath,
    jobId,
    projectionStore?.policy?.maxResultBytes || MAX_JOB_RESULT_BYTES
  );
  if (!terminal) {
    throw jobPersistenceError(
      "job_persistence_terminal_missing",
      jobId,
      "Persisted job terminal envelope is missing."
    );
  }
  const projected: any = projectionStore?.get(jobId);
  if (projected && projected.status !== "completed") {
    throw jobPersistenceError(
      "job_persistence_terminal_state_mismatch",
      jobId,
      "Persisted job terminal envelope does not match projection state."
    );
  }
  const artifact: any = projectionStore?.getArtifactInfo(jobId);
  if (
    artifact?.resultDigest &&
    (
      artifact.resultDigest !== terminal.artifactDigest ||
      Number(artifact.resultBytes) !== terminal.artifactBytes
    )
  ) {
    throw jobPersistenceError(
      "job_persistence_terminal_digest_mismatch",
      jobId,
      "Persisted job terminal envelope does not match its projection digest."
    );
  }
  return terminal.result;
}

export async function persistJobPayload(
  userDataPath?: any,
  jobId?: any,
  payload?: any,
  projectionStore: any = null
) : Promise<any> {
  const jobDirectory: any = getJobDirectory(userDataPath, jobId);
  await fs.mkdir(jobDirectory, { recursive: true });
  const serialized: any = JSON.stringify(payload, null, 2);
  const artifact: any = projectionStore?.beginArtifact({
    jobId,
    kind: "payload",
    finalRef: `jobs/${jobId}/payload.json`,
    digest: digestText(serialized),
    byteSize: Buffer.byteLength(serialized)
  });
  try {
    await atomicWriteJsonThroughState(getJobPayloadPath(userDataPath, jobId), payload, {
      trailingNewline: false,
      ignoreMissingParent: true,
      kind: "jobs.payload.write",
      metadata: { jobId }
    });
    if (artifact) {
      projectionStore.publishArtifact(artifact.journalId);
      projectionStore.settleArtifact(artifact.journalId);
    }
  } catch (error: any) {
    if (artifact) projectionStore.abortArtifact(artifact.journalId);
    throw error;
  }
}

export async function loadJobPayload(userDataPath?: any, jobId?: any, projectionStore: any = null) : Promise<any> {
  try {
    const raw: any = await readBoundedText(
      getJobPayloadPath(userDataPath, jobId),
      projectionStore?.policy?.maxPayloadBytes || MAX_JOB_PAYLOAD_BYTES
    );
    try {
      const payload: any = JSON.parse(raw);
      const projected: any = projectionStore?.getArtifactInfo(jobId);
      if (
        projected &&
        projected.payloadDigest &&
        (
          projected.payloadDigest !== digestText(raw) ||
          Number(projected.payloadBytes) !== Buffer.byteLength(raw)
        )
      ) {
        throw jobPersistenceError(
          "job_persistence_payload_digest_mismatch",
          jobId,
          "Persisted job payload does not match its projection digest."
        );
      }
      return payload;
    } catch (error: any) {
      if (error?.name === "JobPersistenceError") throw error;
      throw jobPersistenceError(
        "job_persistence_payload_invalid",
        jobId,
        "Persisted job payload is not valid JSON.",
        error
      );
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error?.name === "JobPersistenceError") throw error;
    throw jobPersistenceError(
      error?.code === FILE_TOO_LARGE
        ? "job_persistence_payload_too_large"
        : "job_persistence_payload_unreadable",
      jobId,
      "Persisted job payload is unreadable.",
      error
    );
  }
}
