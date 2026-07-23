import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { atomicWriteJsonThroughState } from "#lico/product-api";
import {
  getJobDirectory,
  getJobMetaPath,
  getJobPayloadPath,
  getJobResultPath,
  getJobsRootPath,
  RECOVERY_STAGE_MESSAGE
} from "./job-manager-validation.mjs";

function jobPersistenceError(code, jobId, message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.name = "JobPersistenceError";
  error.code = code;
  error.jobId = String(jobId || "");
  return error;
}

const JOB_TERMINAL_FORMAT = "lico.job-terminal";
const JOB_TERMINAL_SCHEMA = "job-terminal-envelope";

async function readPersistedJobTerminal(userDataPath, jobId) {
  let content;
  try {
    content = await fs.readFile(getJobResultPath(userDataPath, jobId), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw jobPersistenceError(
      "job_persistence_terminal_unreadable",
      jobId,
      "Persisted job terminal envelope is unreadable.",
      error
    );
  }
  let envelope;
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
  return envelope;
}

async function readPersistedJobMeta(userDataPath, jobId) {
  let content;
  try {
    content = await fs.readFile(getJobMetaPath(userDataPath, jobId), "utf8");
  } catch (error) {
    const terminal = await readPersistedJobTerminal(userDataPath, jobId);
    if (terminal && error?.code === "ENOENT") {
      await persistJobMeta(userDataPath, terminal.job);
      return terminal.job;
    }
    throw jobPersistenceError(
      error?.code === "ENOENT" ? "job_persistence_meta_missing" : "job_persistence_meta_unreadable",
      jobId,
      "Persisted job metadata is missing or unreadable.",
      error
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const terminal = await readPersistedJobTerminal(userDataPath, jobId);
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
    const terminal = await readPersistedJobTerminal(userDataPath, jobId);
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
    const terminal = await readPersistedJobTerminal(userDataPath, jobId);
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

  const terminal = await readPersistedJobTerminal(userDataPath, jobId);
  if (terminal) {
    if (!isDeepStrictEqual(parsed, terminal.job)) {
      await persistJobMeta(userDataPath, terminal.job);
    }
    return terminal.job;
  }
  return parsed;
}

export async function persistJobMeta(userDataPath, job) {
  const jobDirectory = getJobDirectory(userDataPath, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  await atomicWriteJsonThroughState(getJobMetaPath(userDataPath, job.id), job, {
    trailingNewline: false,
    ignoreMissingParent: true,
    kind: "jobs.meta.write",
    metadata: { jobId: job.id }
  });
}

export async function persistJobTerminal(userDataPath, job, result) {
  if (!job?.id || job.status !== "completed") {
    throw jobPersistenceError(
      "job_persistence_terminal_invalid",
      job?.id,
      "Only a completed job can commit a terminal result."
    );
  }
  const jobDirectory = getJobDirectory(userDataPath, job.id);
  await fs.mkdir(jobDirectory, { recursive: true });
  await atomicWriteJsonThroughState(getJobResultPath(userDataPath, job.id), {
    format: JOB_TERMINAL_FORMAT,
    schema: JOB_TERMINAL_SCHEMA,
    job,
    result
  }, {
    trailingNewline: false,
    ignoreMissingParent: true,
    kind: "jobs.terminal.write",
    metadata: { jobId: job.id }
  });
  await persistJobMeta(userDataPath, job);
}

export async function loadJobResult(userDataPath, jobId) {
  const terminal = await readPersistedJobTerminal(userDataPath, jobId);
  if (!terminal) {
    throw jobPersistenceError(
      "job_persistence_terminal_missing",
      jobId,
      "Persisted job terminal envelope is missing."
    );
  }
  return terminal.result;
}

export async function persistJobPayload(userDataPath, jobId, payload) {
  const jobDirectory = getJobDirectory(userDataPath, jobId);
  await fs.mkdir(jobDirectory, { recursive: true });
  await atomicWriteJsonThroughState(getJobPayloadPath(userDataPath, jobId), payload, {
    trailingNewline: false,
    ignoreMissingParent: true,
    kind: "jobs.payload.write",
    metadata: { jobId }
  });
}

export async function loadJobPayload(userDataPath, jobId) {
  try {
    const raw = await fs.readFile(getJobPayloadPath(userDataPath, jobId), "utf8");
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw jobPersistenceError(
        "job_persistence_payload_invalid",
        jobId,
        "Persisted job payload is not valid JSON.",
        error
      );
    }
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    if (error?.name === "JobPersistenceError") throw error;
    throw jobPersistenceError(
      "job_persistence_payload_unreadable",
      jobId,
      "Persisted job payload is unreadable.",
      error
    );
  }
}

export async function loadPersistedJobs(userDataPath, { recoverActive = true } = {}) {
  const rootPath = getJobsRootPath(userDataPath);
  await fs.mkdir(rootPath, { recursive: true });
  const directoryEntries = await fs.readdir(rootPath, {
    withFileTypes: true
  });
  const jobs = [];
  const recoverableEntries = [];

  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isDirectory()) {
      continue;
    }

    const parsed = await readPersistedJobMeta(userDataPath, directoryEntry.name);

    if (recoverActive && (parsed.status === "queued" || parsed.status === "running")) {
      let payload = null;
      let payloadInvalid = false;
      try {
        payload = await loadJobPayload(userDataPath, directoryEntry.name);
      } catch (error) {
        if (error?.code !== "job_persistence_payload_invalid") throw error;
        payloadInvalid = true;
      }
      const now = new Date().toISOString();
      if (payload) {
        parsed.status = "queued";
        parsed.stage = RECOVERY_STAGE_MESSAGE;
        parsed.error = "";
        parsed.finishedAt = undefined;
        parsed.updatedAt = now;
        await persistJobMeta(userDataPath, parsed);
        recoverableEntries.push({
          jobId: parsed.id,
          payload
        });
      } else {
        parsed.status = "failed";
        parsed.stage = "任务恢复失败";
        parsed.error = payloadInvalid
          ? "服务重启后任务 payload 已损坏，不能继续恢复。"
          : "服务重启后缺少任务 payload，不能继续恢复。";
        parsed.finishedAt = now;
        parsed.updatedAt = now;
        await persistJobMeta(userDataPath, parsed);
      }
    }

    jobs.push(parsed);
  }

  jobs.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  const createdAtByJobId = new Map(jobs.map((job) => [job.id, String(job.createdAt || "")]));
  recoverableEntries.sort((left, right) => {
    return String(createdAtByJobId.get(left.jobId) || "")
      .localeCompare(String(createdAtByJobId.get(right.jobId) || ""));
  });
  return {
    jobs,
    recoverableEntries
  };
}

export async function listPersistedJobMetas(userDataPath) {
  const rootPath = getJobsRootPath(userDataPath);
  await fs.mkdir(rootPath, { recursive: true });
  const directoryEntries = await fs.readdir(rootPath, {
    withFileTypes: true
  });
  const jobs = [];

  for (const directoryEntry of directoryEntries) {
    if (!directoryEntry.isDirectory()) {
      continue;
    }

    jobs.push(await readPersistedJobMeta(userDataPath, directoryEntry.name));
  }

  jobs.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  return jobs;
}
