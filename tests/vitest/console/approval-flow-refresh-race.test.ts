import { ref } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleMcpAuthorizationController } from "../../../apps/console/composables/console-mcp-authorization-controller";
import { createConsoleOperationPermissionPendingController } from "../../../apps/console/composables/console-operation-permission-pending-controller";
import { createConsoleApprovalFlowSelectionController } from "../../../apps/console/composables/console-approval-flow-selection-controller";

const apiMocks: any = vi.hoisted(() : any => ({
  listMcpAuthorizationRequests: vi.fn(),
  listPendingOperations: vi.fn(),
  resolveMcpAuthorizationRequest: vi.fn(),
  resolvePendingOperation: vi.fn(),
}));

vi.mock("../../../apps/console/lib/authorization-governance-client", () : any => ({
  listMcpAuthorizationRequests: apiMocks.listMcpAuthorizationRequests,
  resolveMcpAuthorizationRequest: apiMocks.resolveMcpAuthorizationRequest,
}));

vi.mock("../../../apps/console/lib/operation-permission-client", () : any => ({
  listPendingOperations: apiMocks.listPendingOperations,
  resolvePendingOperation: apiMocks.resolvePendingOperation,
}));

function deferred<T>() : any {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise: any = new Promise<T>((resolvePromise?: any, rejectPromise?: any) : any => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

beforeEach(() : any => {
  vi.clearAllMocks();
});

describe("approval list refresh generations", () : any => {
  it("shares a sidebar selection with both approval APIs before rendering the target card", async () : Promise<any> => {
    const mcpAuthorizationStatus: any = ref<
      "all" | "pending" | "approved" | "rejected"
    >("pending");
    const operationPermissionPendingStatus: any = ref<
      "all" | "pending" | "approved" | "rejected"
    >("pending");
    const refreshMcpAuthorizationRequests: any = vi.fn(async () : Promise<any> => {});
    const refreshOperationPermissionPendingOperations: any = vi.fn(async () : Promise<any> => {});
    const selection: any = createConsoleApprovalFlowSelectionController({
      mcpAuthorizationStatus,
      operationPermissionPendingStatus,
      refreshMcpAuthorizationRequests,
      refreshOperationPermissionPendingOperations,
    });

    await selection.selectApprovalFlowStatus("all");

    expect(selection.approvalFlowSelectedStatus.value).toBe("all");
    expect(mcpAuthorizationStatus.value).toBe("all");
    expect(operationPermissionPendingStatus.value).toBe("all");
    expect(refreshMcpAuthorizationRequests).toHaveBeenCalledTimes(1);
    expect(
      refreshOperationPermissionPendingOperations,
    ).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale MCP response or error overwrite the latest selection", async () : Promise<any> => {
    const stale: any = deferred<any>();
    const latest: any = deferred<any>();
    apiMocks.listMcpAuthorizationRequests
      .mockImplementationOnce(() : any => stale.promise)
      .mockImplementationOnce(() : any => latest.promise);
    const error: any = ref("");
    const controller: any = createConsoleMcpAuthorizationController({
      clearBusy: vi.fn(),
      error,
      setBusy: vi.fn(),
    });

    const staleRefresh: any = controller.refreshMcpAuthorizationRequests();
    controller.mcpAuthorizationStatus.value = "all";
    const latestRefresh: any = controller.refreshMcpAuthorizationRequests();
    latest.resolve({
      requests: [{ requestId: "request-latest", status: "approved" }],
    });
    await latestRefresh;
    stale.reject(new Error("stale request failed"));
    await staleRefresh;

    expect(apiMocks.listMcpAuthorizationRequests.mock.calls).toEqual([
      ["pending"],
      ["all"],
    ]);
    expect(controller.mcpAuthorizationRequests.value).toEqual([
      { requestId: "request-latest", status: "approved" },
    ]);
    expect(error.value).toBe("");
  });

  it("does not let an older Operation Permission response overwrite the latest list", async () : Promise<any> => {
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

    const staleRefresh: any =
      controller.refreshOperationPermissionPendingOperations();
    controller.operationPermissionPendingStatus.value = "all";
    const latestRefresh: any =
      controller.refreshOperationPermissionPendingOperations();
    latest.resolve({
      pendingOperations: [
        {
          pendingOperationId: "pending-latest",
          status: "completed",
          toolId: "repo.write",
        },
      ],
    });
    await latestRefresh;
    stale.resolve({
      pendingOperations: [
        {
          pendingOperationId: "pending-stale",
          status: "pending",
          toolId: "repo.read",
        },
      ],
    });
    await staleRefresh;

    expect(apiMocks.listPendingOperations.mock.calls).toEqual([
      ["pending", 100],
      ["all", 100],
    ]);
    expect(controller.operationPermissionPendingOperations.value).toEqual([
      {
        pendingOperationId: "pending-latest",
        status: "completed",
        toolId: "repo.write",
      },
    ]);
    expect(error.value).toBe("");
  });
});
