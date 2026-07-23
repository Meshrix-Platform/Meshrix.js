import { normalizeManifestKey } from "./job-manager-validation.mjs";

export function createActiveManifestIndex({ activeManifestJobs, jobs }) {
  function rememberActiveManifestJob(job) {
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

  function forgetActiveManifestJob(job) {
    const manifestKey = normalizeManifestKey(job);
    const activeManifestKey = `${manifestKey}::${job?.archiveBatchId || ""}`;
    if (manifestKey && activeManifestJobs.get(activeManifestKey) === job?.id) {
      activeManifestJobs.delete(activeManifestKey);
    }
  }

  function getActiveManifestJob(manifestKey, archiveBatchId = "") {
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
