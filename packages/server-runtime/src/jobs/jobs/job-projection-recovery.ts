import { createHash } from "node:crypto";
import fsNative from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  getJobPayloadPath,
  getJobResultPath,
  getJobsRootPath,
  SAFE_JOB_ID_PATTERN
} from "./job-manager-validation.ts";
import { errorProperty } from "./contracts.ts";
import type { createJobProjectionStore } from "./job-projection-store.ts";

type ProjectionStore = ReturnType<typeof createJobProjectionStore>;
type ArtifactJournalEntry = ReturnType<ProjectionStore["listArtifactJournal"]>[number];

function recoveryError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

async function exists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (errorProperty(error, "code") === "ENOENT") return false;
    throw error;
  }
}

async function digestFile(filePath: string, maxBytes: number) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw recoveryError(
      "job_projection_artifact_too_large",
      "Job artifact exceeds its recovery byte limit."
    );
  }
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = fsNative.createReadStream(filePath, {
    highWaterMark: 64 * 1024
  });
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      stream.destroy();
      throw recoveryError(
        "job_projection_artifact_too_large",
        "Job artifact exceeds its recovery byte limit."
      );
    }
    hash.update(chunk);
  }
  return { digest: hash.digest("hex"), byteSize: bytes };
}

function expectedArtifactPath(userDataPath: string, entry: ArtifactJournalEntry) {
  if (!SAFE_JOB_ID_PATTERN.test(entry.jobId)) {
    throw recoveryError(
      "job_projection_journal_identity_invalid",
      "Job artifact journal identity is invalid."
    );
  }
  if (entry.kind === "payload") return getJobPayloadPath(userDataPath, entry.jobId);
  if (entry.kind === "result") return getJobResultPath(userDataPath, entry.jobId);
  throw recoveryError(
    "job_projection_journal_kind_invalid",
    "Job artifact journal kind is invalid."
  );
}

export async function reconcileJobProjectionArtifacts({
  userDataPath,
  projectionStore,
  limit = projectionStore.policy.cleanupBatch
}: {
  userDataPath: string;
  projectionStore: ProjectionStore;
  limit?: number;
}) {
  const entries = projectionStore.listArtifactJournal({ limit });
  let reconciled = 0;
  for (const entry of entries) {
    if (entry.kind === "delete_job") {
      if (!SAFE_JOB_ID_PATTERN.test(entry.jobId)) {
        throw recoveryError(
          "job_projection_journal_identity_invalid",
          "Job deletion journal identity is invalid."
        );
      }
      await fs.rm(path.join(getJobsRootPath(userDataPath), entry.jobId), {
        recursive: true,
        force: true
      });
      projectionStore.settleDeletion(entry.jobId);
      reconciled += 1;
      continue;
    }
    const filePath = expectedArtifactPath(userDataPath, entry);
    if (!await exists(filePath)) {
      if (entry.state === "prepared") {
        projectionStore.abortArtifact(entry.journalId);
        reconciled += 1;
        continue;
      }
      throw recoveryError(
        "job_projection_artifact_missing",
        "Published job artifact is missing."
      );
    }
    const maximum = entry.kind === "payload"
      ? projectionStore.policy.maxPayloadBytes
      : projectionStore.policy.maxResultBytes;
    const artifact = await digestFile(filePath, maximum);
    if (artifact.digest !== entry.digest || artifact.byteSize !== entry.byteSize) {
      throw recoveryError(
        "job_projection_artifact_digest_mismatch",
        "Published job artifact does not match its journal."
      );
    }
    if (entry.state === "prepared") projectionStore.publishArtifact(entry.journalId);
    if (entry.kind === "result" && entry.job) projectionStore.upsert(entry.job);
    projectionStore.settleArtifact(entry.journalId);
    reconciled += 1;
  }
  return { reconciled, remaining: Math.max(0, entries.length - reconciled) };
}
