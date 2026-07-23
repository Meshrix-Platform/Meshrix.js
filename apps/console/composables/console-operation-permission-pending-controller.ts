import { ref, type Ref } from "vue";
import {
  listPendingOperations,
  resolvePendingOperation as resolvePendingOperationApi,
  type OperationPermissionPendingOperation,
} from "../lib/operation-permission-client";
import type { OptionBarOption } from "../types/app";

type OperationPermissionPendingStatus = "all" | "pending" | "approved" | "rejected";

type ConsoleOperationPermissionPendingControllerOptions = {
  clearBusy: (key: string) => void;
  error: Ref<string>;
  setBusy: (key: string) => void;
};

export function createConsoleOperationPermissionPendingController(
  options: ConsoleOperationPermissionPendingControllerOptions,
) {
  const operationPermissionPendingOperations = ref<OperationPermissionPendingOperation[]>([]);
  const operationPermissionPendingStatus = ref<OperationPermissionPendingStatus>("pending");
  const operationPermissionPendingStatusOptionBarOptions: OptionBarOption[] = [
    { value: "pending", label: "待审批" },
    { value: "approved", label: "已批准" },
    { value: "rejected", label: "已拒绝" },
    { value: "all", label: "所有" },
  ];

  async function refreshOperationPermissionPendingOperations() {
    const busy = "operation-permission-pending:refresh";
    options.setBusy(busy);
    try {
      const result = await listPendingOperations(operationPermissionPendingStatus.value, 100);
      operationPermissionPendingOperations.value = Array.isArray(result.pendingOperations)
        ? result.pendingOperations
        : [];
    } catch (nextError) {
      operationPermissionPendingOperations.value = [];
      options.error.value =
        nextError instanceof Error ? nextError.message : "加载 Operation Permission 待审批事项失败。";
    } finally {
      options.clearBusy(busy);
    }
  }

  async function resolveOperationPermissionPendingOperation(
    pendingOperationId: string,
    resolution: "approved" | "rejected",
  ) {
    const busy = `operation-permission-pending:resolve:${pendingOperationId}`;
    options.setBusy(busy);
    try {
      await resolvePendingOperationApi(pendingOperationId, {
        resolution,
        reason: "resolved_from_console_approval_flow",
      });
      await refreshOperationPermissionPendingOperations();
    } catch (nextError) {
      options.error.value =
        nextError instanceof Error ? nextError.message : "处理 Operation Permission 待审批事项失败。";
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
