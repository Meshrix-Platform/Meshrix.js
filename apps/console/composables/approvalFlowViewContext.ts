import { inject, provide, type InjectionKey } from "vue";
import type { useApprovalFlowViewController } from "./console-approval-flow-view-controller";

export type ApprovalFlowViewContext = ReturnType<typeof useApprovalFlowViewController>;

const approvalFlowViewKey = Symbol("approval-flow-view") as InjectionKey<ApprovalFlowViewContext>;

export function provideApprovalFlowView(context: ApprovalFlowViewContext) {
  provide(approvalFlowViewKey, context);
}

export function useApprovalFlowViewContext() {
  const context = inject(approvalFlowViewKey);
  if (!context) {
    throw new Error("Approval flow view context is not available");
  }
  return context;
}
