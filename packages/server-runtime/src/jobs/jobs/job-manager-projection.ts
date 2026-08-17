import { unifiedRegistrationForTask } from "#meshrix/product-api";
import { CHECKPOINT_FILE_SAMPLE_LIMIT } from "./job-manager-validation.ts";
import type { CheckpointReceipt, JobDocument } from "./contracts.ts";

export function cloneCheckpointReceipt(
  receipt?: CheckpointReceipt | null,
  { includeFiles = false }: { includeFiles?: boolean } = {}
) {
  if (!receipt || typeof receipt !== "object") {
    return receipt || null;
  }

  const files = Array.isArray(receipt.files) ? receipt.files : [];
  const cloned = {
    ...receipt
  };

  if (includeFiles || files.length <= CHECKPOINT_FILE_SAMPLE_LIMIT) {
    cloned.files = files.map((file) => ({
      ...file
    }));
    return cloned;
  }

  delete cloned.files;
  cloned.fileSamples = files.slice(0, CHECKPOINT_FILE_SAMPLE_LIMIT).map((file) => ({
    ...file
  }));
  cloned.filesTruncated = true;
  cloned.filesReturned = CHECKPOINT_FILE_SAMPLE_LIMIT;
  cloned.filesTotal = Number(receipt.fileCount || files.length || 0);
  return cloned;
}

export function cloneJob(
  job?: JobDocument | null,
  { includeCheckpointFiles = false }: { includeCheckpointFiles?: boolean } = {}
) {
  if (!job) {
    return null;
  }

  const cloned = {
    ...job,
    checkpointReceipt: cloneCheckpointReceipt(job.checkpointReceipt, {
      includeFiles: includeCheckpointFiles
    }),
    resultSummary: job.resultSummary
      ? {
          ...job.resultSummary
        }
      : undefined
  };
  cloned.unifiedRegistration = unifiedRegistrationForTask(cloned, {
    taskType: "import_parse_job",
    taskId: cloned.id,
    source: "jobs",
    feature: "工作队列"
  });
  return cloned;
}
