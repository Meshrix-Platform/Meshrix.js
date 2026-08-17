import { normalizeManifestKey } from "./job-manager-validation.ts";
import type { JobDocument } from "./contracts.ts";

export function createActiveManifestIndex({
  activeManifestJobs,
  jobs
}: {
  activeManifestJobs: Map<string, string>;
  jobs: Map<string, JobDocument>;
}) {
  function rememberActiveManifestJob(job?: JobDocument | null) {
    if (!job || !["queued", "running"].includes(job.status)) {
      return;
    }
    const manifestKey = normalizeManifestKey(job);
    if (!manifestKey) {
      return;
    }
    const activeManifestKey = `${manifestKey}::${job.archiveBatchId || ""}`;
    const existingJobId = activeManifestJobs.get(activeManifestKey);
    const existingJob = existingJobId ? jobs.get(existingJobId) : null;
    if (!existingJob || String(job.createdAt || "") < String(existingJob.createdAt || "")) {
      activeManifestJobs.set(activeManifestKey, job.id);
    }
  }

  function forgetActiveManifestJob(job?: JobDocument | null) {
    const manifestKey = normalizeManifestKey(job);
    const activeManifestKey = `${manifestKey}::${job?.archiveBatchId || ""}`;
    if (manifestKey && activeManifestJobs.get(activeManifestKey) === job?.id) {
      activeManifestJobs.delete(activeManifestKey);
    }
  }

  function getActiveManifestJob(manifestKey?: string, archiveBatchId = "") {
    if (!manifestKey) {
      return null;
    }
    const activeManifestKey = `${manifestKey}::${archiveBatchId || ""}`;
    const existingJobId = activeManifestJobs.get(activeManifestKey);
    const existingJob = existingJobId ? jobs.get(existingJobId) : null;
    if (!existingJob || !["queued", "running"].includes(existingJob.status)) {
      activeManifestJobs.delete(activeManifestKey);
      return null;
    }
    return existingJob;
  }

  return {
    rememberActiveManifestJob,
    forgetActiveManifestJob,
    getActiveManifestJob
  };
}
