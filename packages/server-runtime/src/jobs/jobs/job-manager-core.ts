import { normalizeManifestKey } from "./job-manager-validation.ts";

export function createActiveManifestIndex({ activeManifestJobs, jobs }: Record<string, any>) : any {
  function rememberActiveManifestJob(job?: any) : any {
    if (!job || !["queued", "running"].includes(job.status)) {
      return;
    }
    const manifestKey: any = normalizeManifestKey(job);
    if (!manifestKey) {
      return;
    }
    const activeManifestKey: any = `${manifestKey}::${job.archiveBatchId || ""}`;
    const existingJobId: any = activeManifestJobs.get(activeManifestKey);
    const existingJob: any = existingJobId ? jobs.get(existingJobId) : null;
    if (!existingJob || String(job.createdAt || "") < String(existingJob.createdAt || "")) {
      activeManifestJobs.set(activeManifestKey, job.id);
    }
  }

  function forgetActiveManifestJob(job?: any) : any {
    const manifestKey: any = normalizeManifestKey(job);
    const activeManifestKey: any = `${manifestKey}::${job?.archiveBatchId || ""}`;
    if (manifestKey && activeManifestJobs.get(activeManifestKey) === job?.id) {
      activeManifestJobs.delete(activeManifestKey);
    }
  }

  function getActiveManifestJob(manifestKey?: any, archiveBatchId: any = "") : any {
    if (!manifestKey) {
      return null;
    }
    const activeManifestKey: any = `${manifestKey}::${archiveBatchId || ""}`;
    const existingJobId: any = activeManifestJobs.get(activeManifestKey);
    const existingJob: any = existingJobId ? jobs.get(existingJobId) : null;
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
