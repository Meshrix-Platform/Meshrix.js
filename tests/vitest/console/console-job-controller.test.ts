import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleJobController } from "../../../apps/console/composables/console-job-controller";

const jobsClientMock: any = vi.hoisted(() : any => ({
  cancelJob: vi.fn(),
  deleteJob: vi.fn(),
}));

vi.mock("../../../apps/console/lib/jobs-client", () : any => ({
  cancelJob: jobsClientMock.cancelJob,
  deleteJob: jobsClientMock.deleteJob,
}));

function makeJob(id: string, status = "running"): any {
  return {
    id,
    status,
    createdAt: "2026-10-08T00:00:00.000Z",
    updatedAt: "2026-10-08T00:01:00.000Z",
    progressPercent: 50,
    stage: "processing",
  };
}

function makeState(items: any[]): any {
  return {
    jobs: {
      items,
      summary: {
        totalCount: items.length,
        queuedCount: items.filter((job) => job.status === "queued").length,
        runningCount: items.filter((job) => job.status === "running").length,
        completedCount: items.filter((job) => job.status === "completed").length,
        failedCount: items.filter((job) => job.status === "failed").length,
        cancelledCount: items.filter((job) => job.status === "cancelled").length,
      },
    },
  };
}

function createController(state: any) {
  const busy = new Set<string>();
  const clearBusy = vi.fn((key: string) => busy.delete(key));
  const refreshState = vi.fn(async () => undefined);
  const controller = createConsoleJobController({
    clearBusy,
    confirmAction: vi.fn(async () => true),
    consoleState: state,
    error: ref(""),
    refreshState,
    setBusy: vi.fn((key: string) => busy.add(key)),
  });
  return { busy, clearBusy, controller, refreshState };
}

beforeEach(() : any => {
  vi.clearAllMocks();
});

describe("console job mutations", () : any => {
  it("removes a deleted job from current state without fetching the full state", async () : Promise<any> => {
    const deleted = makeJob("job-delete");
    const remaining = makeJob("job-remaining", "queued");
    const state = ref(makeState([deleted, remaining]));
    const { busy, clearBusy, controller, refreshState } = createController(state);
    jobsClientMock.deleteJob.mockResolvedValue({ ok: true, deletedJob: deleted });

    await controller.deleteJob(deleted.id);

    expect(jobsClientMock.deleteJob).toHaveBeenCalledTimes(1);
    expect(state.value.jobs.items.map((job: any) => job.id)).toEqual([remaining.id]);
    expect(state.value.jobs.summary).toMatchObject({ totalCount: 1, queuedCount: 1, runningCount: 0 });
    expect(refreshState).not.toHaveBeenCalled();
    expect(busy.has(`job:${deleted.id}`)).toBe(false);
    expect(clearBusy).toHaveBeenCalledWith(`job:${deleted.id}`);
  });

  it("applies the canceled job response without fetching the full state", async () : Promise<any> => {
    const running = makeJob("job-cancel");
    const cancelled = { ...running, status: "cancelled", stage: "任务已取消" };
    const state = ref(makeState([running]));
    const { busy, clearBusy, controller, refreshState } = createController(state);
    jobsClientMock.cancelJob.mockResolvedValue(cancelled);

    await controller.cancelJob(running.id);

    expect(jobsClientMock.cancelJob).toHaveBeenCalledTimes(1);
    expect(state.value.jobs.items).toEqual([cancelled]);
    expect(state.value.jobs.summary).toMatchObject({ totalCount: 1, runningCount: 0, cancelledCount: 1 });
    expect(refreshState).not.toHaveBeenCalled();
    expect(busy.has(`job:${running.id}`)).toBe(false);
    expect(clearBusy).toHaveBeenCalledWith(`job:${running.id}`);
  });
});
