import { unifiedRegistrationForTask } from "#meshrix/product-api";
import { CHECKPOINT_FILE_SAMPLE_LIMIT } from "./job-manager-validation.ts";

export function cloneCheckpointReceipt(receipt?: any, { includeFiles = false }: Record<string, any> = {}) : any {
  if (!receipt || typeof receipt !== "object") {
    return receipt || null;
  }

  const files: any = Array.isArray(receipt.files) ? receipt.files : [];
  const cloned: Record<string, any> = {
    ...receipt
  };

  if (includeFiles || files.length <= CHECKPOINT_FILE_SAMPLE_LIMIT) {
    cloned.files = files.map((file?: any) : any => ({
      ...file
    }));
    return cloned;
  }

  delete cloned.files;
  cloned.fileSamples = files.slice(0, CHECKPOINT_FILE_SAMPLE_LIMIT).map((file?: any) : any => ({
    ...file
  }));
  cloned.filesTruncated = true;
  cloned.filesReturned = CHECKPOINT_FILE_SAMPLE_LIMIT;
  cloned.filesTotal = Number(receipt.fileCount || files.length || 0);
  return cloned;
}

export function cloneJob(job?: any, { includeCheckpointFiles = false }: Record<string, any> = {}) : any {
  if (!job) {
    return null;
  }

  const cloned: Record<string, any> = {
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
