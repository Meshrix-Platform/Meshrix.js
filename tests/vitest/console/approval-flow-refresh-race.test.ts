import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleOperationPermissionPendingController } from "../../../apps/console/composables/console-operation-permission-pending-controller";
import { createConsoleApprovalFlowSelectionController } from "../../../apps/console/composables/console-approval-flow-selection-controller";

const apiMocks: any = vi.hoisted(() : any => ({
  listPendingOperations: vi.fn(),
  resolvePendingOperation: vi.fn(),
}));

vi.mock("../../../apps/console/lib/operation-permission-client", () : any => apiMocks);

function deferred<T>() : any {
  let resolve!: (value: T) => void;
  const promise: any = new Promise<T>((resolvePromise?: any) : any => { resolve = resolvePromise; });
  return { promise, resolve };
}

beforeEach(() : any => { vi.clearAllMocks(); });

describe("governed operation approval refresh generations", () : any => {
  it("updates the pending-operation status and refreshes its only source", async () : Promise<any> => {
    const operationPermissionPendingStatus: any = ref("pending");
    const refreshOperationPermissionPendingOperations: any = vi.fn(async () : Promise<any> => {});
    const selection: any = createConsoleApprovalFlowSelectionController({
      operationPermissionPendingStatus,
      refreshOperationPermissionPendingOperations,
    });

    await selection.selectApprovalFlowStatus("all");

    expect(selection.approvalFlowSelectedStatus.value).toBe("all");
    expect(operationPermissionPendingStatus.value).toBe("all");
    expect(refreshOperationPermissionPendingOperations).toHaveBeenCalledTimes(1);
  });

  it("does not let an older response overwrite the latest list", async () : Promise<any> => {
    const stale: any = deferred<any>();
    const latest: any = deferred<any>();
    apiMocks.listPendingOperations
      .mockImplementationOnce(() : any => stale.promise)
      .mockImplementationOnce(() : any => latest.promise);
    const error: any = ref("");
    const controller: any = createConsoleOperationPermissionPendingController({
      clearBusy: vi.fn(),
      error,
      setBusy: vi.fn(),
    });

    const staleRefresh: any = controller.refreshOperationPermissionPendingOperations();
    controller.operationPermissionPendingStatus.value = "all";
    const latestRefresh: any = controller.refreshOperationPermissionPendingOperations();
    latest.resolve({ pendingOperations: [{ pendingOperationId: "pending-latest", status: "completed", toolId: "repo.write" }] });
    await latestRefresh;
    stale.resolve({ pendingOperations: [{ pendingOperationId: "pending-stale", status: "pending", toolId: "repo.read" }] });
    await staleRefresh;

    expect(apiMocks.listPendingOperations.mock.calls).toEqual([["pending", 100], ["all", 100]]);
    expect(controller.operationPermissionPendingOperations.value).toEqual([
      { pendingOperationId: "pending-latest", status: "completed", toolId: "repo.write" },
    ]);
    expect(error.value).toBe("");
  });
});
