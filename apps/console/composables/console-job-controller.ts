import { computed, type Ref } from "vue";
import { cancelJob as cancelJobRequest, deleteJob as deleteJobRequest } from "../lib/jobs-client";
import type { ServerConsoleState, SplitJob, SplitJobListResponse } from "../lib/types";
import type { ConsoleConfirmAction } from "./console-confirm-controller";
import { parseTime } from "./console-format-utils";

type ConsoleJobControllerOptions = {
  consoleState: Ref<ServerConsoleState | null>;
  error: Ref<string>;
  clearAllBusy: () => void;
  confirmAction: ConsoleConfirmAction;
  refreshState: () => Promise<unknown>;
  setBusy: (key: string) => void;
};

export function createConsoleJobController(options: ConsoleJobControllerOptions) {
  function recalculateJobSummary(items: SplitJob[]): SplitJobListResponse["summary"] {
    return {
      totalCount: items.length,
      queuedCount: items.filter((job) => job.status === "queued").length,
      runningCount: items.filter((job) => job.status === "running").length,
      completedCount: items.filter((job) => job.status === "completed").length,
      failedCount: items.filter((job) => job.status === "failed").length,
      cancelledCount: items.filter((job) => job.status === "cancelled").length,
    };
  }

  function upsertJobFromEvent(job: SplitJob) {
    if (!options.consoleState.value || !job?.id) {
      return false;
    }
    const existingItems = options.consoleState.value.jobs.items || [];
    const nextItems = [
      job,
      ...existingItems.filter((item) => item.id !== job.id),
    ].sort((left, right) =>
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

  function removeJobFromEvent(jobId: string) {
    if (!options.consoleState.value || !jobId) {
      return false;
    }
    const nextItems = (options.consoleState.value.jobs.items || []).filter(
      (item) => item.id !== jobId,
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

  async function deleteJob(jobId: string) {
    if (!(await options.confirmAction(`删除任务“${jobId}”？`, { tone: "danger" }))) {
      return;
    }

    options.setBusy(`job:${jobId}`);
    options.error.value = "";

    try {
      await deleteJobRequest(jobId);
      await options.refreshState();
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "删除任务失败。";
      options.clearAllBusy();
    }
  }

  async function cancelJob(jobId: string) {
    if (!(await options.confirmAction(`取消任务“${jobId}”？`))) return;
    options.setBusy(`job:${jobId}`);
    options.error.value = "";
    try {
      await cancelJobRequest(jobId);
      await options.refreshState();
    } catch (nextError) {
      options.error.value = nextError instanceof Error ? nextError.message : "取消任务失败。";
      options.clearAllBusy();
    }
  }

  const filteredJobs = computed(() =>
    [...(options.consoleState.value?.jobs.items || [])].sort(
      (left, right) => parseTime(right.updatedAt) - parseTime(left.updatedAt),
    ),
  );

  const recentJobs = computed(() => filteredJobs.value);
  const activeJobCount = computed(() => {
    const summary = options.consoleState.value?.jobs.summary;
    return (summary?.queuedCount || 0) + (summary?.runningCount || 0);
  });
  const latestJob = computed(() => filteredJobs.value[0] || null);

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
