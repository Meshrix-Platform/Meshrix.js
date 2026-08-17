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
import {
  errorProperty,
  isJobDocument,
  isJobPayload,
  isObjectRecord,
  type CodedError,
  type JobDocument,
  type JobPayload,
  type JobResult
} from "./contracts.ts";
import type { createJobProjectionStore } from "./job-projection-store.ts";

type ProjectionStore = ReturnType<typeof createJobProjectionStore>;

interface TerminalEnvelope {
  format: typeof JOB_TERMINAL_FORMAT;
  schema: typeof JOB_TERMINAL_SCHEMA;
  job: JobDocument;
  result: JobResult;
  artifactDigest: string;
  artifactBytes: number;
}

function jobPersistenceError(code: string, jobId: unknown, message: string, cause: unknown = null) {
  const error = new Error(message, cause ? { cause } : undefined) as CodedError;
  error.name = "JobPersistenceError";
  error.code = code;
  error.jobId = String(jobId || "");
  return error;
}

const JOB_TERMINAL_FORMAT = "meshrix.job-terminal";
const JOB_TERMINAL_SCHEMA = "job-terminal-envelope";
const MAX_JOB_METADATA_BYTES = 256 * 1024;
const MAX_JOB_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MAX_JOB_RESULT_BYTES = 256 * 1024 * 1024;
const FILE_TOO_LARGE = "job_persistence_file_too_large";

function digestText(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function readBoundedText(filePath: string, maxBytes: number) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw Object.assign(new Error("Persisted job file exceeds its byte limit."), {
        code: FILE_TOO_LARGE
      });
    }
    const content = Buffer.allocUnsafe(Number(stat.size));
    let offset = 0;
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
    const extra = Buffer.allocUnsafe(1);
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
  userDataPath: string,
  jobId: string,
  maxBytes = MAX_JOB_RESULT_BYTES
) {
  let content: string;
  try {
    content = await readBoundedText(
      getJobResultPath(userDataPath, jobId),
      maxBytes
    );
  } catch (error) {
    if (errorProperty(error, "code") === "ENOENT") return null;
    throw jobPersistenceError(
      errorProperty(error, "code") === FILE_TOO_LARGE
        ? "job_persistence_terminal_too_large"
        : "job_persistence_terminal_unreadable",
      jobId,
      "Persisted job terminal envelope is unreadable.",
      error
    );
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(content);
  } catch (error) {
    throw jobPersistenceError(
      "job_persistence_terminal_invalid",
      jobId,
      "Persisted job terminal envelope is not valid JSON.",
      error
    );
  }
  if (
    !isObjectRecord(envelope)
    || envelope.format !== JOB_TERMINAL_FORMAT
    || envelope.schema !== JOB_TERMINAL_SCHEMA
    || !isJobDocument(envelope.job)
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
  return envelope as Record<string, unknown> & TerminalEnvelope;
}

export async function readPersistedJobMeta(
  userDataPath: string,
  jobId: string,
  {
    maxMetadataBytes = MAX_JOB_METADATA_BYTES,
    maxResultBytes = MAX_JOB_RESULT_BYTES
  }: { maxMetadataBytes?: number; maxResultBytes?: number } = {}
) {
  let content: string;
  try {
    content = await readBoundedText(
      getJobMetaPath(userDataPath, jobId),
      maxMetadataBytes
    );
  } catch (error) {
    const terminal = await readPersistedJobTerminal(
      userDataPath,
      jobId,
      maxResultBytes
    );
    if (terminal && errorProperty(error, "code") === "ENOENT") {
      await persistJobMeta(userDataPath, terminal.job);
      return terminal.job;
    }
    throw jobPersistenceError(
      errorProperty(error, "code") === "ENOENT"
        ? "job_persistence_meta_missing"
        : errorProperty(error, "code") === FILE_TOO_LARGE
          ? "job_persistence_meta_too_large"
          : "job_persistence_meta_unreadable",
      jobId,
      "Persisted job metadata is missing or unreadable.",
      error
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const terminal = await readPersistedJobTerminal(
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

  if (!isJobDocument(parsed)) {
    const terminal = await readPersistedJobTerminal(
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
    const terminal = await readPersistedJobTerminal(
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
      fs.stat(getJobMetaPath(userDataPath, jobId)).catch(() => null),
      fs.stat(getJobResultPath(userDataPath, jobId)).catch(() => null)
    ]);
    if (!terminalStat || (metaStat && metaStat.mtimeMs >= terminalStat.mtimeMs)) {
      return parsed;
    }
  }

  const terminal = await readPersistedJobTerminal(
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

export async function persistJobMeta(userDataPath: string, job: JobDocument, projectionStore: ProjectionStore | null = null) {
  projectionStore?.upsert(job);
  const jobDirectory = getJobDirectory(userDataPath, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  await atomicWriteJsonThroughState(getJobMetaPath(userDataPath, job.id), job, {
    trailingNewline: false,
    ignoreMissingParent: true,
    kind: "jobs.meta.write",
    metadata: { jobId: job.id }
  });
}

export async function persistJobTerminal(
  userDataPath: string,
  job: JobDocument,
  result: JobResult,
  projectionStore: ProjectionStore | null = null
) {
  if (!job?.id || job.status !== "completed") {
    throw jobPersistenceError(
      "job_persistence_terminal_invalid",
      job?.id,
      "Only a completed job can commit a terminal result."
    );
  }
  const jobDirectory = getJobDirectory(userDataPath, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  const envelope = {
    format: JOB_TERMINAL_FORMAT,
    schema: JOB_TERMINAL_SCHEMA,
    job,
    result
  };
  const serialized = JSON.stringify(envelope, null, 2);
  const artifact = projectionStore?.beginArtifact({
    jobId: job.id,
    kind: "result",
    finalRef: `jobs/${job.id}/result.json`,
    digest: digestText(serialized),
    byteSize: Buffer.byteLength(serialized),
    job
  });
  let artifactPublished = false;
  try {
    await atomicWriteJsonThroughState(getJobResultPath(userDataPath, job.id), envelope, {
      trailingNewline: false,
      ignoreMissingParent: true,
      kind: "jobs.terminal.write",
      metadata: { jobId: job.id }
    });
    if (artifact && projectionStore) {
      projectionStore.publishArtifact(artifact.journalId);
      artifactPublished = true;
    }
    await persistJobMeta(userDataPath, job, projectionStore);
    if (artifact && projectionStore) projectionStore.settleArtifact(artifact.journalId);
  } catch (error) {
    if (artifact && !artifactPublished && projectionStore) {
      projectionStore.abortArtifact(artifact.journalId);
    }
    throw error;
  }
}

export async function loadJobResult(userDataPath: string, jobId: string, projectionStore: ProjectionStore | null = null) {
  const terminal = await readPersistedJobTerminal(
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
  const projected = projectionStore?.get(jobId);
  if (projected && projected.status !== "completed") {
    throw jobPersistenceError(
      "job_persistence_terminal_state_mismatch",
      jobId,
      "Persisted job terminal envelope does not match projection state."
    );
  }
  const artifact = projectionStore?.getArtifactInfo(jobId);
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
  userDataPath: string,
  jobId: string,
  payload: JobPayload,
  projectionStore: ProjectionStore | null = null
) {
  const jobDirectory = getJobDirectory(userDataPath, jobId);
  await fs.mkdir(jobDirectory, { recursive: true });
  const serialized = JSON.stringify(payload, null, 2);
  const artifact = projectionStore?.beginArtifact({
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
    if (artifact && projectionStore) {
      projectionStore.publishArtifact(artifact.journalId);
      projectionStore.settleArtifact(artifact.journalId);
    }
  } catch (error) {
    if (artifact && projectionStore) projectionStore.abortArtifact(artifact.journalId);
    throw error;
  }
}

export async function loadJobPayload(userDataPath: string, jobId: string, projectionStore: ProjectionStore | null = null): Promise<JobPayload | null> {
  try {
    const raw = await readBoundedText(
      getJobPayloadPath(userDataPath, jobId),
      projectionStore?.policy?.maxPayloadBytes || MAX_JOB_PAYLOAD_BYTES
    );
    try {
      const payload: unknown = JSON.parse(raw);
      if (!isJobPayload(payload)) {
        throw jobPersistenceError(
          "job_persistence_payload_invalid",
          jobId,
          "Persisted job payload must be an object."
        );
      }
      const projected = projectionStore?.getArtifactInfo(jobId);
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
    } catch (error) {
      if (errorProperty(error, "name") === "JobPersistenceError") throw error;
      throw jobPersistenceError(
        "job_persistence_payload_invalid",
        jobId,
        "Persisted job payload is not valid JSON.",
        error
      );
    }
  } catch (error) {
    if (errorProperty(error, "code") === "ENOENT") {
      return null;
    }
    if (errorProperty(error, "name") === "JobPersistenceError") throw error;
    throw jobPersistenceError(
      errorProperty(error, "code") === FILE_TOO_LARGE
        ? "job_persistence_payload_too_large"
        : "job_persistence_payload_unreadable",
      jobId,
      "Persisted job payload is unreadable.",
      error
    );
  }
}
