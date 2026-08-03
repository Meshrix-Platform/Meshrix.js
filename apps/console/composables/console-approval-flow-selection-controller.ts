import { ref, type Ref } from "vue";

export type SharedApprovalFlowStatus =
  | "pending"
  | "resolved"
  | "rejected"
  | "all";

type ApiApprovalStatus = "pending" | "rejected" | "all";
type ControllerApprovalStatus =
  | ApiApprovalStatus
  | "approved";

type ConsoleApprovalFlowSelectionControllerOptions = {
  operationPermissionPendingStatus: Ref<ControllerApprovalStatus>;
  refreshOperationPermissionPendingOperations: () => Promise<void>;
};

export function approvalApiStatusForSharedStatus(
  status: SharedApprovalFlowStatus,
): ApiApprovalStatus {
  return status === "pending" || status === "rejected" ? status : "all";
}

export function createConsoleApprovalFlowSelectionController(
  options: ConsoleApprovalFlowSelectionControllerOptions,
) : any {
  const approvalFlowSelectedStatus: any =
    ref<SharedApprovalFlowStatus>("pending");

  async function selectApprovalFlowStatus(status: SharedApprovalFlowStatus) : Promise<any> {
    approvalFlowSelectedStatus.value = status;
    const apiStatus: any = approvalApiStatusForSharedStatus(status);
    options.operationPermissionPendingStatus.value = apiStatus;
    await options.refreshOperationPermissionPendingOperations();
  }

  return {
    approvalFlowSelectedStatus,
    selectApprovalFlowStatus,
  };
}
