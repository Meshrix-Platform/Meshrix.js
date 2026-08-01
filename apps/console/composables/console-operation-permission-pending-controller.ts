import { ref, type Ref } from "vue";
import {
  listPendingOperations,
  resolvePendingOperation as resolvePendingOperationApi,
  type OperationPermissionPendingOperation,
} from "../lib/operation-permission-client";
import type { OptionBarOption } from "../types/app";

type OperationPermissionPendingStatus =
  "all" | "pending" | "approved" | "rejected";

type ConsoleOperationPermissionPendingControllerOptions = {
  clearBusy: (key: string) => void;
  error: Ref<string>;
  setBusy: (key: string) => void;
};

export function createConsoleOperationPermissionPendingController(
  options: ConsoleOperationPermissionPendingControllerOptions,
) : any {
  const operationPermissionPendingOperations: any = ref<
    OperationPermissionPendingOperation[]
  >([]);
  const operationPermissionPendingStatus: any =
    ref<OperationPermissionPendingStatus>("pending");
  const operationPermissionPendingStatusOptionBarOptions: OptionBarOption[] = [
    { value: "pending", label: "待审批" },
    { value: "approved", label: "已批准" },
    { value: "rejected", label: "已拒绝" },
    { value: "all", label: "所有" },
  ];
  let refreshGeneration: any = 0;

  async function refreshOperationPermissionPendingOperations() : Promise<any> {
    const generation: any = ++refreshGeneration;
    const status: any = operationPermissionPendingStatus.value;
    const busy: any = "operation-permission-pending:refresh";
    options.setBusy(busy);
    try {
      const result: any = await listPendingOperations(status, 100);
      if (generation !== refreshGeneration) return;
      operationPermissionPendingOperations.value = Array.isArray(
        result.pendingOperations,
      )
        ? result.pendingOperations
        : [];
    } catch (nextError: any) {
      if (generation !== refreshGeneration) return;
      operationPermissionPendingOperations.value = [];
      options.error.value =
        nextError instanceof Error
          ? nextError.message
          : "加载 Operation Permission 待审批事项失败。";
    } finally {
      if (generation === refreshGeneration) {
        options.clearBusy(busy);
      }
    }
  }

  async function resolveOperationPermissionPendingOperation(
    pendingOperationId: string,
    resolution: "approved" | "rejected",
  ) : Promise<any> {
    const busy: any = `operation-permission-pending:resolve:${pendingOperationId}`;
    options.setBusy(busy);
    try {
      await resolvePendingOperationApi(pendingOperationId, {
        resolution,
        reason: "resolved_from_console_approval_flow",
      });
      await refreshOperationPermissionPendingOperations();
      return true;
    } catch (nextError: any) {
      options.error.value =
        nextError instanceof Error
          ? nextError.message
          : "处理 Operation Permission 待审批事项失败。";
      return false;
    } finally {
      options.clearBusy(busy);
    }
  }

  return {
    operationPermissionPendingOperations,
    operationPermissionPendingStatus,
    operationPermissionPendingStatusOptionBarOptions,
    refreshOperationPermissionPendingOperations,
    resolveOperationPermissionPendingOperation,
  };
}
