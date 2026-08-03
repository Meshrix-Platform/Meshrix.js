import { computed, type Ref } from "vue";
import { cancelJob as cancelJobRequest, deleteJob as deleteJobRequest } from "../lib/jobs-client";
import type { ServerConsoleState, SplitJob, SplitJobListResponse } from "../lib/types";
import type { ConsoleConfirmAction } from "./console-confirm-controller";
import { parseTime } from "./console-format-utils";

type ConsoleJobControllerOptions = {
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  clearBusy: (key: string) => void;
  confirmAction: ConsoleConfirmAction;
  refreshState: () => Promise<unknown>;
  setBusy: (key: string) => void;
};

export function createConsoleJobController(options: ConsoleJobControllerOptions) : any {
  function recalculateJobSummary(items: SplitJob[]): SplitJobListResponse["summary"] {
    return {
      totalCount: items.length,
      queuedCount: items.filter((job?: any) : any => job.status === "queued").length,
      runningCount: items.filter((job?: any) : any => job.status === "running").length,
      completedCount: items.filter((job?: any) : any => job.status === "completed").length,
      failedCount: items.filter((job?: any) : any => job.status === "failed").length,
      cancelledCount: items.filter((job?: any) : any => job.status === "cancelled").length,
    };
  }

  function upsertJobFromEvent(job: SplitJob) : any {
    if (!options.consoleState.value || !job?.id) {
      return false;
    }
    const existingItems: any = options.consoleState.value.jobs.items || [];
    const nextItems: any = [
      job,
      ...existingItems.filter((item?: any) : any => item.id !== job.id),
    ].sort((left?: any, right?: any) : any =>
      String(right.createdAt || "").localeCompare(String(left.createdAt || "")),
    );
    options.consoleState.value = {
      ...options.consoleState.value,
      jobs: {
        summary: recalculateJobSummary(nextItems),
        items: nextItems,
      },
    };
    return true;
  }

  function removeJobFromEvent(jobId: string) : any {
    if (!options.consoleState.value || !jobId) {
      return false;
    }
    const nextItems: any = (options.consoleState.value.jobs.items || []).filter(
      (item?: any) : any => item.id !== jobId,
    );
    options.consoleState.value = {
      ...options.consoleState.value,
      jobs: {
        summary: recalculateJobSummary(nextItems),
        items: nextItems,
      },
    };
    return true;
  }

  async function deleteJob(jobId: string) : Promise<any> {
    if (!(await options.confirmAction(`删除任务“${jobId}”？`, { tone: "danger" }))) {
      return;
    }

    options.setBusy(`job:${jobId}`);
    options.error.value = "";

    try {
      await deleteJobRequest(jobId);
      await options.refreshState();
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "删除任务失败。";
      options.clearBusy(`job:${jobId}`);
    }
  }

  async function cancelJob(jobId: string) : Promise<any> {
    if (!(await options.confirmAction(`取消任务“${jobId}”？`))) return;
    options.setBusy(`job:${jobId}`);
    options.error.value = "";
    try {
      await cancelJobRequest(jobId);
      await options.refreshState();
    } catch (nextError: any) {
      options.error.value = nextError instanceof Error ? nextError.message : "取消任务失败。";
      options.clearBusy(`job:${jobId}`);
    }
  }

  const filteredJobs: any = computed(() : any =>
    [...(options.consoleState.value?.jobs.items || [])].sort(
      (left?: any, right?: any) : any => parseTime(right.updatedAt) - parseTime(left.updatedAt),
    ),
  );

  const recentJobs: any = computed(() : any => filteredJobs.value);
  const activeJobCount: any = computed(() : any => {
    const summary: any = options.consoleState.value?.jobs.summary;
    return (summary?.queuedCount || 0) + (summary?.runningCount || 0);
  });
  const latestJob: any = computed(() : any => filteredJobs.value[0] || null);

  return {
    activeJobCount,
    cancelJob,
    deleteJob,
    filteredJobs,
    latestJob,
    recalculateJobSummary,
    recentJobs,
    removeJobFromEvent,
    upsertJobFromEvent,
  };
}
